import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, AudioLines, BrainCircuit, Camera, CameraOff, ChevronRight, CircleHelp, CircleStop, Cpu, Database, Eye, Gauge, Headphones, LayoutDashboard, MessageSquareText, Mic, Radio, RefreshCw, Send, Settings2, ShieldCheck, Sparkles, Square, Volume2, VolumeX, Waves, Wifi, WifiOff, X } from 'lucide-react';

type Health = { api: string; database: string; ollama: boolean; voicebox: boolean; chat_model: string; vision_model: string; stt_enabled: boolean; tts_configured: boolean };
type Msg = { id: string; role: 'user' | 'assistant'; content: string; vision?: boolean; latency?: number };
const api = '/api';
const timeNow = () => new Date().toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream|null>(null);
  const recorderRef = useRef<MediaRecorder|null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement|null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [health, setHealth] = useState<Health|null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [lastLatency, setLastLatency] = useState<number|null>(null);
  const [conversationId, setConversationId] = useState<string|null>(null);
  const [activeTab, setActiveTab] = useState<'control'|'settings'>('control');
  const [includeVision, setIncludeVision] = useState(true);
  const [clock, setClock] = useState(timeNow());

  useEffect(() => {
    const interval = window.setInterval(() => setClock(timeNow()), 10000);
    return () => window.clearInterval(interval);
  }, []);
  const refreshHealth = useCallback(async () => {
    try { const r = await fetch(`${api}/health`); if(!r.ok) throw new Error(); setHealth(await r.json()); }
    catch { setHealth(null); }
  }, []);
  useEffect(() => { void refreshHealth(); const id=window.setInterval(()=>void refreshHealth(),10000); return ()=>window.clearInterval(id); }, [refreshHealth]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior:'smooth', block:'end' }); }, [messages]);
  useEffect(() => () => { streamRef.current?.getTracks().forEach(t=>t.stop()); audioRef.current?.pause(); }, []);

  const toggleCamera = async () => {
    setError('');
    if (cameraOn) { streamRef.current?.getTracks().forEach(t=>t.stop()); streamRef.current=null; if(videoRef.current)videoRef.current.srcObject=null; setCameraOn(false); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720},facingMode:'user'},audio:false});
      streamRef.current=stream;
      if(videoRef.current){videoRef.current.srcObject=stream; await videoRef.current.play();}
      setCameraOn(true);
    } catch { setError('Нет доступа к веб-камере. Разрешите камеру для localhost в браузере.'); }
  };
  const captureFrame = ():string|null => {
    if(!cameraOn || !videoRef.current || !videoRef.current.videoWidth) return null;
    const canvas=document.createElement('canvas'); const video=videoRef.current;
    const scale=Math.min(1,960/video.videoWidth);canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
    const ctx=canvas.getContext('2d');if(!ctx)return null;
    ctx.drawImage(video,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/jpeg',0.68).split(',')[1];
  };
  const stopPlayback=()=>{audioRef.current?.pause();audioRef.current=null;setSpeaking(false);};
  const playVoice = async (answer:string) => {
    if(!voiceEnabled)return;
    try {
      const r=await fetch(`${api}/tts`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:answer.slice(0,1000)})});
      if(!r.ok)throw new Error((await r.json().catch(()=>null))?.detail||'Voicebox недоступен');
      const blob=await r.blob();const url=URL.createObjectURL(blob);
      const audio=new Audio(url);audioRef.current=audio;setSpeaking(true);
      audio.onended=()=>{setSpeaking(false);URL.revokeObjectURL(url);};
      audio.onerror=()=>{setSpeaking(false);URL.revokeObjectURL(url);};
      await audio.play();
    } catch(e){setSpeaking(false);setError(e instanceof Error?e.message:'Ошибка синтеза речи');}
  };
  const sendMessage=async (raw:string, forceVision=false)=>{
    const prompt=raw.trim();if(!prompt||sending)return;
    setSending(true);setError('');setText('');stopPlayback();
    const image = (forceVision||includeVision) ? captureFrame():null;
    const userMsg:Msg={id:crypto.randomUUID(),role:'user',content:prompt,vision:!!image};
    setMessages(m=>[...m,userMsg]);
    try {
      const response=await fetch(`${api}/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversation_id:conversationId,text:prompt,image})});
      const payload=await response.json().catch(()=>null);
      if(response.status===404)setConversationId(null);
      if(!response.ok||!payload)throw new Error(payload?.detail||'API недоступен — проверь статус сервисов');
      setConversationId(payload.conversation_id);setLastLatency(payload.latency_ms);
      setMessages(m=>[...m,{id:crypto.randomUUID(),role:'assistant',content:payload.answer,latency:payload.latency_ms}]);
      void playVoice(payload.answer);
    } catch(e){setError(e instanceof Error?e.message:'Ошибка запроса');}
    finally{setSending(false);}
  };
  const voiceRecord=async()=>{
    if(micOn){recorderRef.current?.stop();setMicOn(false);return;}
    setError('');
    if(!health?.stt_enabled){setError('Локальное распознавание отключено. Установи ENABLE_STT=true в .env и перезапусти api.');return;}
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      const mime=MediaRecorder.isTypeSupported('audio/webm')?'audio/webm':'';
      const recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);
      chunksRef.current=[];recorderRef.current=recorder;
      recorder.ondataavailable=e=>{if(e.data.size)chunksRef.current.push(e.data);};
      recorder.onstop=async()=>{
        stream.getTracks().forEach(t=>t.stop());setMicOn(false);
        const file=new Blob(chunksRef.current,{type:recorder.mimeType||'audio/webm'});
        const form=new FormData();form.append('audio',file,'recording.webm');
        try{setSending(true);const r=await fetch(`${api}/stt`,{method:'POST',body:form});const payload=await r.json().catch(()=>null);if(!r.ok||!payload)throw new Error(payload?.detail||'Ошибка STT');setSending(false);if(payload.text)await sendMessage(payload.text);else setError('Речь не распознана — попробуй ещё раз.');}
        catch(e){setSending(false);setError(e instanceof Error?e.message:'Ошибка распознавания');}
      };
      recorder.start();setMicOn(true);
    }catch{setError('Не удалось открыть микрофон. Проверь разрешения браузера.');}
  };
  const newSession=()=>{setConversationId(null);setMessages([]);setLastLatency(null);setError('');stopPlayback();};
  const service=(name:string,enabled:boolean|undefined)=> <div className="service"><span className={`service-dot ${enabled?'up':'down'}`}/><span>{name}</span><span className="service-status">{enabled?'ONLINE':'OFFLINE'}</span></div>;
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brandmark"><BrainCircuit size={23}/></div><div><div className="brandname">JARVIS<span>.</span></div><div className="brandhint">PERSONAL AI SYSTEM</div></div></div>
      <div className="side-label">WORKSPACE</div>
      <button className={`nav-item ${activeTab==='control'?'selected':''}`} onClick={()=>setActiveTab('control')}><LayoutDashboard size={18}/>Control Center<ChevronRight size={16} className="nav-chev"/></button>
      <button className={`nav-item ${activeTab==='settings'?'selected':''}`} onClick={()=>setActiveTab('settings')}><Settings2 size={18}/>System Settings<ChevronRight size={16} className="nav-chev"/></button>
      <div className="side-label services-label">LOCAL INFRASTRUCTURE</div>
      {service('API Engine',!!health)}{service('PostgreSQL',health?.database==='online')}{service('Ollama',health?.ollama)}{service('Voicebox',health?.voicebox)}
      <div className="sidebar-bottom"><div className="privacy"><ShieldCheck size={17}/><div><strong>LOCAL FIRST</strong><span>Всё остаётся на твоём ПК</span></div></div><div className="side-version">JARVIS OS <span>v0.1.0 ALPHA</span></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="crumb">SYSTEM <ChevronRight size={13}/> <span>{activeTab==='control'?'CONTROL CENTER':'SETTINGS'}</span></div><div className="top-right"><span className="top-clock">{clock}</span><span className="top-separator"/><span className={`connection ${health?'connected':''}`}>{health?<Wifi size={14}/>:<WifiOff size={14}/>} {health?'SYSTEM ONLINE':'DISCONNECTED'}</span><div className="avatar">J</div></div></header>
      {activeTab==='control'?<div className="workspace">
        <div className="welcome"><div><div className="eyebrow"><span className="live-pulse"/> INTELLIGENCE DASHBOARD / 001</div><h1>Good evening, <span>Commander.</span></h1><p>Твоя локальная AI-система готова наблюдать, слушать и помогать.</p></div><div className="welcome-right"><div className="core-ring"><BrainCircuit size={25}/></div><div><div className="core-title">NEURAL CORE</div><div className="core-sub">{health?.ollama?'CONNECTED':'WAITING FOR MODEL'}</div></div></div></div>
        <div className="metrics"><div className="metric"><div className="metric-icon cyan"><Eye size={17}/></div><div><label>VISION ENGINE</label><strong>{cameraOn?'ACTIVE':'STANDBY'}</strong></div><div className={`metric-status ${cameraOn?'on':''}`}/></div><div className="metric"><div className="metric-icon purple"><AudioLines size={17}/></div><div><label>VOICE SYSTEM</label><strong>{micOn?'RECORDING':health?.stt_enabled?'READY':'STANDBY'}</strong></div><div className={`metric-status ${micOn?'on':''}`}/></div><div className="metric"><div className="metric-icon blue"><Gauge size={17}/></div><div><label>LAST RESPONSE</label><strong>{lastLatency!==null?(lastLatency/1000).toFixed(1)+' s':'—'}</strong></div></div><div className="metric"><div className="metric-icon green"><Cpu size={17}/></div><div><label>AI ENGINE</label><strong>{health?.ollama?'ONLINE':'OFFLINE'}</strong></div><div className={`metric-status ${health?.ollama?'on':''}`}/></div></div>
        <div className="content-grid">
          <section className="panel vision-panel"><div className="panel-top"><div><div className="panel-kicker">01 / VISUAL PERCEPTION</div><h2><Camera size={17}/>Live Vision Feed</h2></div><span className={`pill ${cameraOn?'pill-on':''}`}><span className="small-dot"/>{cameraOn?'LIVE':'STANDBY'}</span></div>
            <div className="video-area"><video ref={videoRef} className={cameraOn?'':'hidden'} muted playsInline autoPlay/>{!cameraOn&&<div className="no-video"><div className="scanner-orb"><Eye size={47}/></div><strong>VISUAL INPUT OFFLINE</strong><span>Подключи веб-камеру, чтобы Jarvis мог видеть мир</span><button className="primary" onClick={()=>void toggleCamera()}><Camera size={16}/> Enable Camera</button></div>}{cameraOn&&<><div className="view-corner tl"/><div className="view-corner tr"/><div className="view-corner bl"/><div className="view-corner br"/><div className="cam-overprint">CAM_01 <span>● LIVE</span></div><div className="cam-bottom">LOCAL CAMERA FEED / NO CLOUD</div></>}</div>
            <div className="vision-actions"><div className="view-info"><Radio size={15}/><span>{cameraOn?'Камера подключена':'Ожидание видеопотока'}</span></div><div className="action-cluster"><button className="small-btn" onClick={()=>void toggleCamera()}>{cameraOn?<CameraOff size={15}/>:<Camera size={15}/>} {cameraOn?'Выключить':'Включить'}</button><button className="small-btn accent" disabled={!cameraOn||sending} onClick={()=>void sendMessage('Что ты сейчас видишь? Опиши сцену подробно.',true)}><Eye size={15}/> Analyze Scene</button></div></div>
          </section>
          <section className="panel chat-panel"><div className="panel-top"><div><div className="panel-kicker">02 / NEURAL COMMUNICATION</div><h2><MessageSquareText size={17}/>Jarvis Chat</h2></div><button className="icon-btn" title="Новая беседа" onClick={newSession}><RefreshCw size={16}/></button></div>
            <div className="chat-body">{messages.length===0?<div className="chat-empty"><div className="jarvis-avatar"><Sparkles size={23}/></div><div className="ai-intro">JARVIS <span>AI ASSISTANT</span></div><h3>Чем могу помочь?</h3><p>Я твой локальный интеллектуальный ассистент. Спроси меня о чём угодно или покажи что-нибудь через камеру.</p><div className="suggestions"><button onClick={()=>void sendMessage('Привет, Jarvis! Представься коротко.')}>👋 Поздороваться</button><button onClick={()=>void sendMessage('Что ты умеешь делать?')}>✨ Возможности</button></div></div>:messages.map(m=><div key={m.id} className={`message ${m.role}`}><div className="msg-icon">{m.role==='assistant'?<BrainCircuit size={16}/>: 'Я'}</div><div className="msg-detail"><div className="msg-header">{m.role==='assistant'?'JARVIS':'YOU'} {m.vision&&<span className="attached"><Camera size={12}/> FRAME</span>}{m.latency!==undefined&&<span>{(m.latency/1000).toFixed(1)}s</span>}</div><div className="msg-text">{m.content}</div></div></div>)}{sending&&<div className="message assistant"><div className="msg-icon"><BrainCircuit size={16}/></div><div className="msg-detail"><div className="msg-header">JARVIS</div><div className="typing"><i/><i/><i/></div></div></div>}<div ref={endRef}/></div>
            {error&&<div className="error-banner"><CircleHelp size={16}/><span>{error}</span><button onClick={()=>setError('')}><X size={14}/></button></div>}
            <form className="composer" onSubmit={e=>{e.preventDefault();void sendMessage(text)}}><div className="composer-input"><input value={text} onChange={e=>setText(e.target.value)} placeholder="Спроси Jarvis о чём угодно..." disabled={sending}/><button className="send" type="submit" disabled={!text.trim()||sending}><Send size={17}/></button></div><div className="composer-footer"><label className="check-control"><input type="checkbox" checked={includeVision} onChange={e=>setIncludeVision(e.target.checked)}/><span>Прикладывать кадр камеры</span></label><span>ENTER TO SEND</span></div></form>
          </section>
        </div>
        <div className="bottom-grid"><section className="panel audio-panel"><div className="panel-top compact"><div><div className="panel-kicker">03 / AUDIO INTERFACE</div><h2><Headphones size={17}/>Voice Control</h2></div><span className={`pill ${micOn?'pill-on':''}`}><span className="small-dot"/>{micOn?'RECORDING':'PUSH TO TALK'}</span></div><div className="audio-content"><div className={`wave ${micOn?'animated':''}`}>{Array.from({length:32},(_,i)=><span key={i} style={{height:`${10+(Math.abs(Math.sin(i*1.7))*25)}px`}}/>)}</div><div className="audio-controls"><button className={`round-mic ${micOn?'recording':''}`} onClick={()=>void voiceRecord()} disabled={sending}>{micOn?<Square size={19} fill="currentColor"/>:<Mic size={20}/>}</button><div className="audio-label"><strong>{micOn?'Идёт запись...':'Нажми для записи'}</strong><span>{health?.stt_enabled?'Локальный Whisper':'Для STT включи ENABLE_STT=true'}</span></div><button className={`sound-toggle ${voiceEnabled?'active':''}`} title="Голосовые ответы Voicebox" onClick={()=>{setVoiceEnabled(!voiceEnabled);if(voiceEnabled)stopPlayback()}}>{voiceEnabled?<Volume2 size={19}/>:<VolumeX size={19}/>}</button>{speaking&&<button className="sound-toggle" title="Прервать речь" onClick={stopPlayback}><CircleStop size={19}/></button>}</div></div></section>
          <section className="panel system-panel"><div className="panel-top compact"><div><div className="panel-kicker">04 / SYSTEM STATUS</div><h2><Activity size={17}/>Runtime Diagnostics</h2></div><button className="icon-btn" onClick={()=>void refreshHealth()} title="Обновить"><RefreshCw size={15}/></button></div><div className="diag-grid"><div className="diag-row"><span><BrainCircuit size={14}/> Text model</span><strong>{health?.chat_model||'—'}</strong></div><div className="diag-row"><span><Eye size={14}/> Vision model</span><strong>{health?.vision_model||'—'}</strong></div><div className="diag-row"><span><Database size={14}/> Database</span><strong className={health?.database==='online'?'green-text':''}>{health?(health.database==='online'?'Connected':'Unavailable'):'—'}</strong></div><div className="diag-row"><span><Waves size={14}/> Voicebox</span><strong className={health?.voicebox?'green-text':''}>{health?.voicebox?'Connected':'Not connected'}</strong></div></div></section></div>
      </div>:<div className="settings-page"><div className="eyebrow">CONFIGURATION / 002</div><h1>System <span>Settings.</span></h1><p>Настройки текущей версии управляются через локальный файл <code>.env</code>. После изменения переменных перезапусти контейнер API.</p><section className="panel settings-panel"><h2><ShieldCheck size={18}/>Privacy by design</h2><p>Jarvis отправляет данные только твоему локальному backend. Камера не записывается в базу. При запросе с визуальным контекстом один JPEG-кадр передаётся в локальную Ollama.</p><div className="settings-list"><div><span>Ollama chat</span><code>{health?.chat_model||'offline'}</code></div><div><span>Ollama vision</span><code>{health?.vision_model||'offline'}</code></div><div><span>Microphone STT</span><b>{health?.stt_enabled?'Enabled':'Disabled'}</b></div><div><span>Voicebox TTS profile</span><b>{health?.tts_configured?'Configured':'Not configured'}</b></div></div></section><button className="primary" onClick={()=>setActiveTab('control')}><ChevronRight size={17}/> Вернуться в Control Center</button></div>}
      <footer className="footer"><span><ShieldCheck size={13}/> PRIVATE BY DESIGN · LOCAL AI</span><span>BUILT FOR THE FUTURE <span className="footer-star">✦</span> JARVIS v0.1</span></footer>
    </main>
  </div>;
}
export default App;
