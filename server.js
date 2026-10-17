const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const NEDIS_ROOT = 'https://apis.data.go.kr/B552657/ErmctInfoInqireService';
const NEDIS_BEDS_URL = `${NEDIS_ROOT}/getEmrrmRltmUsefulSckbdInfoInqire`;
const publicFiles = new Map([
  ['/','index.html'],
  ['/index.html','index.html'],
  ['/__preview-bridge.js','__preview-bridge.js']
]);
const bedCache=new Map();
let facilityCache={expiresAt:0,payload:null,pending:null};
const facilityDetailsCache=new Map();
const geocodeCache=new Map();
const reverseGeocodeCache=new Map();
const routeSummaryCache=new Map();

function sendJson(res,status,payload){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(payload));
}

function parsePoint(value){
  const parts=String(value||'').split(',').map(Number);
  if(parts.length!==2 || !parts.every(Number.isFinite)) return null;
  const [lng,lat]=parts;
  if(lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  return {lng,lat};
}

function decodeXml(value){
  return String(value||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&#x([\da-f]+);/gi,(_,code)=>String.fromCodePoint(parseInt(code,16)))
    .replace(/&#(\d+);/g,(_,code)=>String.fromCodePoint(Number(code)))
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').trim();
}

function xmlValue(xml,tag){
  const match=xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'));
  return match?decodeXml(match[1]):'';
}

function assertNedisSuccess(xml){
  const code=xmlValue(xml,'resultCode');
  if(code&&!['00','0','0000'].includes(code)) throw new Error(xmlValue(xml,'resultMsg')||`NEDIS 응답 오류 (${code})`);
}

function uniqueByHospitalCode(records){
  return [...new Map(records.map(record=>[record.hospitalCode,record])).values()];
}

function parseYesNo(value){
  if(/^(1|y|yes|true)$/i.test(String(value||''))) return true;
  if(/^(0|n|no|false)$/i.test(String(value||''))) return false;
  return null;
}

function parseBedRecords(xml){
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(([,item])=>{
    const raw=xmlValue(item,'hvec').replace(/,/g,'');
    const availableBeds=/^\d+$/.test(raw)?Number(raw):null;
    const latitude=Number(xmlValue(item,'wgs84Lat'));
    const longitude=Number(xmlValue(item,'wgs84Lon'));
    return {
      hospitalCode:xmlValue(item,'hpid'),
      hospitalName:xmlValue(item,'dutyName'),
      availableBeds,
      updatedAt:xmlValue(item,'hvidate'),
      latitude:Number.isFinite(latitude)&&latitude!==0?latitude:null,
      longitude:Number.isFinite(longitude)&&longitude!==0?longitude:null,
      address:xmlValue(item,'dutyAddr'),
      emergencyClass:xmlValue(item,'dutyEmclsName')
    };
  }).filter(item=>item.hospitalCode&&item.hospitalName);
}

async function loadBedData(){
  const key='nationwide';
  let cache=bedCache.get(key);
  if(cache?.payload&&Date.now()<cache.expiresAt) return cache.payload;
  if(cache?.pending) return cache.pending;
  cache={expiresAt:0,payload:null,pending:null};
  bedCache.set(key,cache);
  const serviceKey=process.env.NEDIS_SERVICE_KEY;
  if(!serviceKey) throw new Error('응급의료 병상 서비스 키가 설정되지 않았습니다.');
  let normalizedKey=serviceKey;
  try{ normalizedKey=decodeURIComponent(serviceKey); }catch{}
  cache.pending=(async()=>{
    const hospitals=[];
    let totalCount=0;
    const pageSize=1000;
    for(let pageNo=1;pageNo<=20;pageNo++){
      const query={serviceKey:normalizedKey,pageNo:String(pageNo),numOfRows:String(pageSize)};
      const params=new URLSearchParams(query);
      const response=await fetch(`${NEDIS_BEDS_URL}?${params}`,{
        headers:{Accept:'application/xml,text/xml'},signal:AbortSignal.timeout(20000)
      });
      const xml=await response.text();
      if(!response.ok) throw new Error(`병상정보 API 요청 실패 (${response.status})`);
      assertNedisSuccess(xml);
      if(pageNo===1) totalCount=Number(xmlValue(xml,'totalCount'))||0;
      const page=parseBedRecords(xml);
      hospitals.push(...page);
      if(!page.length||hospitals.length>=totalCount||page.length<pageSize) break;
    }
    const uniqueHospitals=uniqueByHospitalCode(hospitals);
    if(!uniqueHospitals.length) throw new Error('NEDIS 응답에 병원 목록이 없습니다. 서비스 신청 상태를 확인해 주세요.');
    if(totalCount>uniqueHospitals.length) throw new Error('NEDIS 병상 목록을 끝까지 가져오지 못했습니다. 일부 자료만으로 검색하지 않습니다.');
    const payload={source:'NEDIS',fetchedAt:new Date().toISOString(),totalCount:totalCount||uniqueHospitals.length,count:uniqueHospitals.length,hospitals:uniqueHospitals};
    cache.expiresAt=Date.now()+60_000; cache.payload=payload; cache.pending=null;
    return payload;
  })().catch(error=>{
    cache.pending=null;
    throw error;
  });
  return cache.pending;
}

function parseFacilityRecords(xml){
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(([,item])=>{
    const latitude=Number(xmlValue(item,'wgs84Lat')||xmlValue(item,'latitude'));
    const longitude=Number(xmlValue(item,'wgs84Lon')||xmlValue(item,'longitude'));
    const departmentText=xmlValue(item,'dgidIdName');
    const openText=xmlValue(item,'dutyEryn');
    const rawFlags=Object.fromEntries(['dutyEryn','hperyn','hpgryn','hpopyn','hvec','hvgc','hvoc']
      .map(tag=>[tag,xmlValue(item,tag)||null]));
    return {
      hospitalCode:xmlValue(item,'hpid'),
      hospitalName:xmlValue(item,'dutyName'),
      address:xmlValue(item,'dutyAddr'),
      latitude:Number.isFinite(latitude)&&latitude!==0?latitude:null,
      longitude:Number.isFinite(longitude)&&longitude!==0?longitude:null,
      departments:departmentText?departmentText.split(/[|,]/).map(v=>v.trim()).filter(Boolean):null,
      emergencyOpen:parseYesNo(openText),
      emergencyOpenRaw:openText||null,
      rawFlags,
      institutionClass:xmlValue(item,'dutyEmcls'),
      institutionClassName:xmlValue(item,'dutyEmclsName'),
      phone:xmlValue(item,'dutyTel1'),
      emergencyPhone:xmlValue(item,'dutyTel3'),
      fieldNames:[...item.matchAll(/<([A-Za-z][\w]*)>/g)].map(match=>match[1])
    };
  }).filter(item=>item.hospitalCode&&item.hospitalName);
}

async function loadFacilityDirectory(){
  if(facilityCache.payload&&Date.now()<facilityCache.expiresAt) return facilityCache.payload;
  if(facilityCache.pending) return facilityCache.pending;
  const serviceKey=process.env.NEDIS_SERVICE_KEY;
  if(!serviceKey) throw new Error('응급의료 병원정보 서비스 키가 설정되지 않았습니다.');
  let normalizedKey=serviceKey;
  try{ normalizedKey=decodeURIComponent(serviceKey); }catch{}
  facilityCache.pending=(async()=>{
    const facilities=[];
    let totalCount=0;
    const pageSize=1000;
    for(let pageNo=1;pageNo<=20;pageNo++){
      const params=new URLSearchParams({serviceKey:normalizedKey,pageNo:String(pageNo),numOfRows:String(pageSize)});
      const response=await fetch(`${NEDIS_ROOT}/getEgytListInfoInqire?${params}`,{
        headers:{Accept:'application/xml,text/xml'},signal:AbortSignal.timeout(20000)
      });
      const xml=await response.text();
      if(!response.ok) throw new Error(`NEDIS 병원 목록 조회 실패 (${response.status})`);
      assertNedisSuccess(xml);
      if(pageNo===1) totalCount=Number(xmlValue(xml,'totalCount'))||0;
      const page=parseFacilityRecords(xml);
      facilities.push(...page);
      if(!page.length||facilities.length>=totalCount||page.length<pageSize) break;
    }
    const uniqueFacilities=uniqueByHospitalCode(facilities);
    if(!uniqueFacilities.length) throw new Error('NEDIS 병원 목록에서 시설을 찾지 못했습니다.');
    if(totalCount>uniqueFacilities.length) throw new Error('NEDIS 기관 목록을 끝까지 가져오지 못했습니다. 일부 자료만으로 검색하지 않습니다.');
    const payload={source:'NEDIS',fetchedAt:new Date().toISOString(),totalCount:totalCount||uniqueFacilities.length,facilities:uniqueFacilities};
    facilityCache={expiresAt:Date.now()+86_400_000,payload,pending:null};
    return payload;
  })().catch(error=>{ facilityCache.pending=null; throw error; });
  return facilityCache.pending;
}

async function hospitalDirectory(req,res){
  if(req.method!=='GET') return sendJson(res,405,{error:'GET 요청만 지원합니다.'});
  try{ return sendJson(res,200,await loadFacilityDirectory()); }
  catch(error){ return sendJson(res,502,{error:error.message||'병원 목록을 불러오지 못했습니다.'}); }
}

async function hospitalDetails(req,res){
  if(req.method!=='GET') return sendJson(res,405,{error:'GET 요청만 지원합니다.'});
  const hospitalCode=new URL(req.url,'http://localhost').searchParams.get('hospitalCode')||'';
  if(!/^[A-Z0-9]{6,12}$/i.test(hospitalCode)) return sendJson(res,400,{error:'병원 코드가 올바르지 않습니다.'});
  const cached=facilityDetailsCache.get(hospitalCode);
  if(cached?.payload&&Date.now()<cached.expiresAt) return sendJson(res,200,cached.payload);
  if(cached?.pending){
    try{return sendJson(res,200,await cached.pending);}
    catch(error){return sendJson(res,502,{error:error.message||'기관 상세정보를 조회하지 못했습니다.'});}
  }
  const serviceKey=process.env.NEDIS_SERVICE_KEY;
  if(!serviceKey) return sendJson(res,503,{error:'서버에 NEDIS_SERVICE_KEY가 설정되지 않았습니다.'});
  let normalizedKey=serviceKey;
  try{normalizedKey=decodeURIComponent(serviceKey);}catch{}
  const entry={expiresAt:0,payload:null,pending:null};
  entry.pending=(async()=>{
    const params=new URLSearchParams({serviceKey:normalizedKey,HPID:hospitalCode});
    const response=await fetch(`${NEDIS_ROOT}/getEgytBassInfoInqire?${params}`,{
      headers:{Accept:'application/xml,text/xml'},signal:AbortSignal.timeout(15000)
    });
    const xml=await response.text();
    if(!response.ok) throw new Error(`NEDIS 기관 상세정보 조회 실패 (${response.status})`);
    assertNedisSuccess(xml);
    const facility=parseFacilityRecords(xml)[0];
    if(!facility) throw new Error('NEDIS 기관 상세정보가 비어 있습니다.');
    const payload={source:'NEDIS',fetchedAt:new Date().toISOString(),facility};
    entry.payload=payload; entry.expiresAt=Date.now()+86_400_000; entry.pending=null;
    return payload;
  })().catch(error=>{entry.pending=null; throw error;});
  facilityDetailsCache.set(hospitalCode,entry);
  try{return sendJson(res,200,await entry.pending);}
  catch(error){facilityDetailsCache.delete(hospitalCode); return sendJson(res,502,{error:error.message||'기관 상세정보를 조회하지 못했습니다.'});}
}

async function geocodeAddress(req,res){
  if(req.method!=='GET') return sendJson(res,405,{error:'GET 요청만 지원합니다.'});
  const query=new URL(req.url,'http://localhost').searchParams.get('address')?.trim()||'';
  if(query.length<2||query.length>120) return sendJson(res,400,{error:'주소를 2~120자로 입력해 주세요.'});
  const cached=geocodeCache.get(query);
  if(cached&&Date.now()<cached.expiresAt) return sendJson(res,200,cached.payload);
  const apiKey=process.env.KAKAO_MOBILITY_REST_API_KEY;
  if(!apiKey) return sendJson(res,503,{error:'주소 검색을 사용할 수 없습니다. 현재 위치 또는 지도 선택을 이용해 주세요.'});
  const params=new URLSearchParams({query});
  try{
    const response=await fetch(`https://dapi.kakao.com/v2/local/search/address.json?${params}`,{
      headers:{Authorization:`KakaoAK ${apiKey}`},signal:AbortSignal.timeout(10000)
    });
    const data=await response.json().catch(()=>null);
    if(!response.ok) return sendJson(res,502,{error:data?.message||'주소 검색에 실패했습니다.'});
    let results=(data?.documents||[]).filter(item=>Number.isFinite(Number(item.y))&&Number.isFinite(Number(item.x))).slice(0,5).map(item=>({
      address:item.road_address?.address_name||item.address_name,
      secondaryAddress:item.road_address&&item.address_name!==item.road_address.address_name?item.address_name:'',
      latitude:Number(item.y),longitude:Number(item.x)
    }));
    if(!results.length){
      const placeResponse=await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?${params}`,{
        headers:{Authorization:`KakaoAK ${apiKey}`},signal:AbortSignal.timeout(10000)
      });
      const places=await placeResponse.json().catch(()=>null);
      if(!placeResponse.ok) return sendJson(res,502,{error:places?.message||'장소 검색에 실패했습니다.'});
      results=(places?.documents||[]).filter(item=>Number.isFinite(Number(item.y))&&Number.isFinite(Number(item.x))).slice(0,5).map(item=>({
        address:item.place_name,secondaryAddress:item.road_address_name||item.address_name||item.category_name||'',
        latitude:Number(item.y),longitude:Number(item.x)
      }));
    }
    if(!results.length) return sendJson(res,404,{error:'주소에서 위치를 찾지 못했습니다. 더 자세한 주소를 입력해 주세요.'});
    const payload={source:'Kakao Local',fetchedAt:new Date().toISOString(),results};
    geocodeCache.set(query,{expiresAt:Date.now()+60*60_000,payload});
    return sendJson(res,200,payload);
  }catch{
    return sendJson(res,502,{error:'주소 검색 서버에 연결하지 못했습니다.'});
  }
}

async function reverseGeocode(req,res){
  if(req.method!=='GET') return sendJson(res,405,{error:'GET 요청만 지원합니다.'});
  const params=new URL(req.url,'http://localhost').searchParams;
  const latitude=Number(params.get('lat')),longitude=Number(params.get('lng'));
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude < -90||latitude > 90||longitude < -180||longitude > 180){
    return sendJson(res,400,{error:'위치 좌표가 올바르지 않습니다.'});
  }
  const cacheKey=`${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  const cached=reverseGeocodeCache.get(cacheKey);
  if(cached&&Date.now()<cached.expiresAt) return sendJson(res,200,cached.payload);
  const apiKey=process.env.KAKAO_MOBILITY_REST_API_KEY;
  if(!apiKey) return sendJson(res,503,{error:'위치 이름을 확인할 수 없습니다.'});
  const query=new URLSearchParams({x:String(longitude),y:String(latitude)});
  try{
    const response=await fetch(`https://dapi.kakao.com/v2/local/geo/coord2regioncode.json?${query}`,{
      headers:{Authorization:`KakaoAK ${apiKey}`},signal:AbortSignal.timeout(10000)
    });
    const data=await response.json().catch(()=>null);
    if(!response.ok) return sendJson(res,502,{error:data?.message||'위치 이름을 확인하지 못했습니다.'});
    const region=(data?.documents||[]).find(item=>item.region_type==='H')||(data?.documents||[])[0];
    if(!region) return sendJson(res,404,{error:'위치 이름을 찾지 못했습니다.'});
    const city=region.region_2depth_name||region.region_1depth_name||'';
    const neighborhood=region.region_4depth_name||region.region_3depth_name||'';
    const label=[city,neighborhood].filter((part,index,array)=>part&&array.indexOf(part)===index).join(' ')
      ||region.address_name||'현재 위치';
    const payload={source:'Kakao Local',label};
    reverseGeocodeCache.set(cacheKey,{expiresAt:Date.now()+24*60*60_000,payload});
    return sendJson(res,200,payload);
  }catch{
    return sendJson(res,502,{error:'위치 이름을 확인하지 못했습니다.'});
  }
}

async function hospitalBeds(req,res){
  if(req.method!=='GET') return sendJson(res,405,{error:'GET 요청만 지원합니다.'});
  try{
    return sendJson(res,200,await loadBedData());
  }catch(error){
    return sendJson(res,502,{error:error.message||'실시간 병상정보를 조회하지 못했습니다.'});
  }
}

async function fetchSingleSummary(origin,destination,apiKey){
  const params=new URLSearchParams({
    origin:`${origin.lng},${origin.lat}`,
    destination:`${destination.lng},${destination.lat}`,
    priority:'TIME',
    summary:'true'
  });
  try{
    const response=await fetch(`https://apis-navi.kakaomobility.com/v1/directions?${params}`,{
      headers:{Authorization:`KakaoAK ${apiKey}`,'Content-Type':'application/json'},
      signal:AbortSignal.timeout(15000)
    });
    const payload=await response.json().catch(()=>null);
    if(!response.ok) return {error:payload?.message||`길찾기 실패 (${response.status})`};
    const route=payload?.routes?.find(item=>item.result_code===0);
    const distance=Number(route?.summary?.distance), duration=Number(route?.summary?.duration);
    if(!Number.isFinite(distance)||!Number.isFinite(duration)) return {error:route?.result_msg||'경로 요약이 없습니다.'};
    return {distance,duration,error:null};
  }catch{
    return {error:'단일 목적지 경로 조회에 실패했습니다.'};
  }
}

async function directions(url,req,res){
  if(req.method!=='GET') return sendJson(res,405,{error:'GET 요청만 지원합니다.'});
  const apiKey=process.env.KAKAO_MOBILITY_REST_API_KEY;
  if(!apiKey) return sendJson(res,503,{error:'서버에 Kakao Mobility REST 키가 설정되지 않았습니다.'});
  const origin=parsePoint(url.searchParams.get('origin'));
  const destination=parsePoint(url.searchParams.get('destination'));
  if(!origin || !destination) return sendJson(res,400,{error:'출발지 또는 목적지 좌표가 올바르지 않습니다.'});

  const params=new URLSearchParams({
    origin:`${origin.lng},${origin.lat}`,
    destination:`${destination.lng},${destination.lat}`,
    priority:'TIME',
    summary:'false',
    alternatives:'false',
    road_details:'false'
  });
  let response;
  try{
    response=await fetch(`https://apis-navi.kakaomobility.com/v1/directions?${params}`,{
      headers:{Authorization:`KakaoAK ${apiKey}`,'Content-Type':'application/json'},
      signal:AbortSignal.timeout(15000)
    });
  }catch{
    return sendJson(res,502,{error:'카카오 길찾기 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'});
  }

  const result=await response.json().catch(()=>null);
  if(!response.ok){
    const status=response.status===401||response.status===403?502:response.status;
    return sendJson(res,status,{error:result?.message||`카카오 길찾기 요청 실패 (${response.status})`});
  }
  const route=result?.routes?.find(item=>item.result_code===0);
  if(!route?.summary) return sendJson(res,422,{error:route?.result_msg||'해당 위치의 경로를 찾지 못했습니다.'});

  const pathPoints=[];
  const roadNames=[];
  const guides=[];
  for(const section of route.sections||[]){
    for(const road of section.roads||[]){
      if(road.name && roadNames.at(-1)!==road.name) roadNames.push(road.name);
      const vertices=road.vertexes||[];
      for(let i=0;i+1<vertices.length;i+=2){
        const lng=Number(vertices[i]),lat=Number(vertices[i+1]);
        if(Number.isFinite(lng)&&Number.isFinite(lat)){
          const previous=pathPoints.at(-1);
          if(!previous || previous.lng!==lng || previous.lat!==lat) pathPoints.push({lng,lat});
        }
      }
    }
    for(const guide of section.guides||[]){
      if(guide.guidance && !['출발지','목적지'].includes(guide.guidance)) guides.push(guide.guidance);
    }
  }
  if(pathPoints.length<2) return sendJson(res,502,{error:'경로 좌표가 응답에 포함되지 않았습니다.'});

  sendJson(res,200,{
    distance:route.summary.distance,
    duration:route.summary.duration,
    fare:route.summary.fare||null,
    path:pathPoints,
    roads:roadNames.slice(0,30),
    guides:guides.slice(0,12)
  });
}

async function readJsonBody(req){
  let size=0;
  const chunks=[];
  for await(const chunk of req){
    size+=chunk.length;
    if(size>32_768) throw new Error('요청 데이터가 너무 큽니다.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function computeDirectionsSummaries(origin,items,apiKey){
  let response;
  try{
    response=await fetch('https://apis-navi.kakaomobility.com/v1/destinations/directions',{
      method:'POST',headers:{Authorization:`KakaoAK ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({origin:{x:String(origin.lng),y:String(origin.lat)},destinations:items,radius:10000,priority:'TIME',roadevent:0}),
      signal:AbortSignal.timeout(20000)
    });
  }catch{throw new Error('카카오 실시간 경로 비교에 연결하지 못했습니다.');}
  const result=await response.json().catch(()=>null);
  if(!response.ok) throw new Error(result?.message||`카카오 다중 목적지 길찾기 실패 (${response.status})`);
  const routes=(result?.routes||[]).map(route=>{
    const valid=route.result_code===0&&Number.isFinite(Number(route.summary?.distance))&&Number.isFinite(Number(route.summary?.duration));
    return {id:String(route.key),distance:valid?Number(route.summary.distance):null,duration:valid?Number(route.summary.duration):null,error:valid?null:(route.result_msg||'경로를 찾지 못했습니다.')};
  });
  const routeById=new Map(routes.map(route=>[route.id,route]));
  const missing=items.filter(item=>!routeById.get(item.key)||routeById.get(item.key).error);
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,missing.length)},async()=>{
    while(next<missing.length){
      const item=missing[next++];
      const summary=await fetchSingleSummary(origin,{lng:Number(item.x),lat:Number(item.y)},apiKey);
      routeById.set(item.key,{id:item.key,...summary});
    }
  }));
  return {routes:items.map(item=>routeById.get(item.key)).filter(Boolean)};
}

async function directionsSummaries(req,res){
  if(req.method!=='POST') return sendJson(res,405,{error:'POST 요청만 지원합니다.'});
  const apiKey=process.env.KAKAO_MOBILITY_REST_API_KEY;
  if(!apiKey) return sendJson(res,503,{error:'서버에 Kakao Mobility REST 키가 설정되지 않았습니다.'});
  let body;
  try{body=await readJsonBody(req);}catch(error){return sendJson(res,400,{error:error.message||'요청 내용을 읽지 못했습니다.'});}
  const origin=parsePoint(`${body?.origin?.lng},${body?.origin?.lat}`),destinations=body?.destinations;
  if(!origin||!Array.isArray(destinations)||destinations.length<1||destinations.length>29) return sendJson(res,400,{error:'출발지 또는 병원 목록이 올바르지 않습니다.'});
  const items=[],ids=new Set();
  for(const item of destinations){
    const id=String(item?.id||''),point=parsePoint(`${item?.lng},${item?.lat}`);
    if(!/^[A-Z0-9]{6,12}$/i.test(id)||ids.has(id)||!point) return sendJson(res,400,{error:'병원 코드 또는 좌표가 올바르지 않습니다.'});
    ids.add(id);items.push({x:String(point.lng),y:String(point.lat),key:id});
  }
  const cacheKey=JSON.stringify([origin,items]);
  const cached=routeSummaryCache.get(cacheKey);
  if(cached?.payload&&Date.now()<cached.expiresAt) return sendJson(res,200,cached.payload);
  if(cached?.pending){
    try{return sendJson(res,200,await cached.pending);}
    catch(error){return sendJson(res,502,{error:error.message||'경로 비교에 실패했습니다.'});}
  }
  const entry={expiresAt:0,payload:null,pending:null};
  entry.pending=computeDirectionsSummaries(origin,items,apiKey).then(payload=>{
    entry.payload=payload;entry.expiresAt=Date.now()+30_000;entry.pending=null;
    if(routeSummaryCache.size>500) routeSummaryCache.delete(routeSummaryCache.keys().next().value);
    return payload;
  }).catch(error=>{entry.pending=null;throw error;});
  routeSummaryCache.set(cacheKey,entry);
  try{return sendJson(res,200,await entry.pending);}
  catch(error){routeSummaryCache.delete(cacheKey);return sendJson(res,502,{error:error.message||'경로 비교에 실패했습니다.'});}
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/directions'){
    await directions(url,req,res);
    return;
  }
  if(url.pathname==='/api/directions/summaries'){
    await directionsSummaries(req,res);
    return;
  }
  if(url.pathname==='/api/hospital-beds'){
    await hospitalBeds(req,res);
    return;
  }
  if(url.pathname==='/api/hospital-directory'){
    await hospitalDirectory(req,res);
    return;
  }
  if(url.pathname==='/api/hospital-details'){
    await hospitalDetails(req,res);
    return;
  }
  if(url.pathname==='/api/geocode'){
    await geocodeAddress(req,res);
    return;
  }
  if(url.pathname==='/api/reverse-geocode'){
    await reverseGeocode(req,res);
    return;
  }
  if(req.method!=='GET' && req.method!=='HEAD') return sendJson(res,405,{error:'GET 요청만 지원합니다.'});
  const file=publicFiles.get(url.pathname);
  if(!file){ res.writeHead(404,{'cache-control':'no-store'}); res.end('Not found'); return; }
  try{
    const content=await fs.readFile(path.join(root,file));
    const type=file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8';
    res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:content);
  }catch{
    res.writeHead(500,{'cache-control':'no-store'}); res.end('Server error');
  }
});

server.listen(port,'0.0.0.0',()=>process.stdout.write(`SAVIOR listening on ${port}\n`));
