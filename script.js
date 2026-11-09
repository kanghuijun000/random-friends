const $=s=>document.querySelector(s);const screens=["home","matching","chat","call"];let selectedMode="chat";let localStream=null;let cameraOn=false;let micOn=false;
function show(name){screens.forEach(id=>$("#"+id).classList.toggle("active",id===name));window.scrollTo(0,0)}
function mode(){selectedMode=$('input[name="mode"]:checked').value;document.querySelectorAll(".mode-card").forEach(card=>card.classList.toggle("selected",card.querySelector("input").checked))}
document.querySelectorAll('input[name="mode"]').forEach(el=>el.addEventListener("change",mode));
document.querySelectorAll('input[name="scope"]').forEach(el=>el.addEventListener("change",()=>{$("#country-wrap").hidden=$('input[name="scope"]:checked').value!=="country"}));
function beginSearch(){if(selectedMode==="call"){show("matching");$("#matching-mode-label").textContent="RANDOM CALL";$("#matching-description").textContent="통화 상대를 찾을 준비를 하고 있습니다."}else{show("matching");$("#matching-mode-label").textContent="RANDOM CHAT";$("#matching-description").textContent="채팅 상대를 찾을 준비를 하고 있습니다."} }
function endMatch(){stopLocalMedia();show("home")}
function next(){stopLocalMedia();if(selectedMode==="call"){show("matching");$("#matching-mode-label").textContent="RANDOM CALL";$("#matching-description").textContent="다음 통화 상대를 찾을 준비를 하고 있습니다."}else{show("matching");$("#matching-mode-label").textContent="RANDOM CHAT";$("#matching-description").textContent="다음 채팅 상대를 찾을 준비를 하고 있습니다."}}
$("#start-btn").addEventListener("click",beginSearch);$("#end-waiting").addEventListener("click",endMatch);$("#cancel-search").addEventListener("click",endMatch);
$("#next-chat").addEventListener("click",()=>{$("#messages").innerHTML='<div class="empty-chat"><div class="empty-icon">✦</div><b>새로운 대화방</b><p>새 상대를 찾는 중입니다.</p></div>';next()});
$("#end-chat").addEventListener("click",endMatch);$("#next-call").addEventListener("click",next);$("#end-call").addEventListener("click",endMatch);
$("#chat-form").addEventListener("submit",e=>e.preventDefault());
async function toggleCamera(){if(cameraOn){stopLocalMedia();return}try{localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:false});$("#local-video").srcObject=localStream;$("#local-video").hidden=false;$("#camera-state").textContent="카메라 켜짐";cameraOn=true;$("#camera-toggle").setAttribute("aria-pressed","true");$("#camera-toggle small").textContent="카메라 끄기"}catch(err){alert("카메라를 사용할 수 없습니다. 브라우저 권한과 HTTPS 연결을 확인해 주세요.")}}
function stopLocalMedia(){if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}cameraOn=false;$("#local-video").srcObject=null;$("#local-video").hidden=true;$("#camera-state").textContent="카메라 꺼짐";$("#camera-toggle").setAttribute("aria-pressed","false");$("#camera-toggle small").textContent="카메라 켜기"}
$("#camera-toggle").addEventListener("click",toggleCamera);
$("#mic-toggle").addEventListener("click",()=>{micOn=!micOn;$("#mic-toggle").setAttribute("aria-pressed",String(micOn));$("#mic-toggle small").textContent=micOn?"마이크 끄기":"마이크 켜기"});
window.addEventListener("pagehide",stopLocalMedia);
if("serviceWorker" in navigator && location.protocol!=="file:"){window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}))}
