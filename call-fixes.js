/* NAIJALITE - call, live-stream and call-alert fixes
 *
 * Load this AFTER your main <script> block, right before </body> in index.html:
 *     <script src="/call-fixes.js"></script>
 * It replaces the broken call / live functions at runtime (same function names).
 */
(function () {
  'use strict';

  // =====================================================================
  // CONFIG - fill these in
  // =====================================================================

  // TURN is REQUIRED for calls/streams between different mobile networks.
  // Easiest: create a free account at https://www.metered.ca , open TURN Server ->
  // "Credentials API" and paste the URL here, e.g.
  //   'https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOUR_KEY'
  const TURN_CREDENTIALS_URL = '';

  // ...or paste fixed servers instead:
  // { urls: 'turn:HOST:443?transport=tcp', username: 'USER', credential: 'PASS' }
  const STATIC_TURN_SERVERS = [];

  // Web Push public key. Generate a pair with:  npx web-push generate-vapid-keys
  const VAPID_PUBLIC_KEY = '';

  const RING_TIMEOUT_MS = 45000;

  // =====================================================================
  // Helpers
  // =====================================================================
  const $ = id => document.getElementById(id);
  const sdpJson = d => ({ type: d.type, sdp: d.sdp });
  const asObj = v => (typeof v === 'string' ? JSON.parse(v) : v);

  let iceCache = null, iceCacheAt = 0;
  async function getIceServers() {
    if (iceCache && Date.now() - iceCacheAt < 10 * 60 * 1000) return iceCache;
    let servers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
    try {
      if (TURN_CREDENTIALS_URL) {
        const r = await fetch(TURN_CREDENTIALS_URL);
        const turn = await r.json();
        if (Array.isArray(turn)) servers = servers.concat(turn);
      }
    } catch (e) { console.warn('[ice] TURN credentials fetch failed', e); }
    servers = servers.concat(STATIC_TURN_SERVERS);
    if (servers.length <= 2) {
      console.warn('[ice] No TURN server configured - calls and streams will fail on many mobile networks.');
    }
    iceCache = servers;
    iceCacheAt = Date.now();
    return servers;
  }

  // Wait until ALL ICE candidates are inside the SDP, so we never lose candidates
  // (the old code sent candidates separately and the other side often missed them).
  function waitForIce(pc, ms) {
    ms = ms || 4000;
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      let timer = null;
      const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
      const finish = () => {
        pc.removeEventListener('icegatheringstatechange', check);
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, ms);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  function getMedia(type, facing) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: type === 'video' ? { facingMode: facing } : false
    });
  }

  function mediaErrorText(err) {
    if (!navigator.mediaDevices) return 'Camera/microphone need HTTPS.';
    if (err && err.name === 'NotAllowedError') return 'Microphone/camera permission was denied. Allow it in your browser settings and try again.';
    if (err && err.name === 'NotFoundError') return 'No microphone/camera found on this device.';
    return 'Could not start the call: ' + (err && err.message ? err.message : err);
  }

  // Console helper: run  await nlCheckIce()  to see if TURN works ("relay" must appear)
  window.nlCheckIce = async function () {
    const pc = new RTCPeerConnection({ iceServers: await getIceServers() });
    const types = new Set();
    pc.onicecandidate = e => { if (e.candidate) types.add(e.candidate.type); };
    pc.createDataChannel('x');
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc, 6000);
    pc.close();
    const out = Array.from(types);
    console.log('ICE candidate types:', out, out.includes('relay') ? 'TURN works' : 'NO relay candidate - TURN is not working');
    return out;
  };

  // =====================================================================
  // Ringtone (plays only if the user has interacted with the page before)
  // =====================================================================
  let ringCtx = null, ringTimer = null;
  function startRingtone() {
    stopRingtone();
    try {
      ringCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (ringCtx.resume) ringCtx.resume();
      const beep = () => {
        if (!ringCtx) return;
        const o = ringCtx.createOscillator();
        const g = ringCtx.createGain();
        o.frequency.value = 480;
        g.gain.value = 0.2;
        o.connect(g); g.connect(ringCtx.destination);
        o.start(); o.stop(ringCtx.currentTime + 0.5);
        if (navigator.vibrate) navigator.vibrate([300, 200, 300]);
      };
      beep();
      ringTimer = setInterval(beep, 1800);
    } catch (e) { /* no audio, ignore */ }
  }
  function stopRingtone() {
    clearInterval(ringTimer); ringTimer = null;
    if (ringCtx) { try { ringCtx.close(); } catch (e) {} ringCtx = null; }
  }

  // =====================================================================
  // Realtime listeners (incoming calls + live list)
  // =====================================================================
  function setupRealtimeListeners() {
    if (callSub) supabaseClient.removeChannel(callSub);

    callSub = supabaseClient
      .channel('calls-for-' + currentUser.id)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'calls', filter: 'receiver_id=eq.' + currentUser.id },
        payload => { if (payload.new.status === 'ringing') showIncomingCallModal(payload.new); })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls', filter: 'receiver_id=eq.' + currentUser.id },
        payload => {
          // caller hung up before we answered
          if (incomingCallPayload && payload.new.id === incomingCallPayload.id && payload.new.status !== 'ringing') {
            hideIncomingCall();
          }
        })
      .subscribe();

    supabaseClient
      .channel('public:livestreams')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'livestreams' }, () => { loadHomeFeed(); })
      .subscribe();
  }

  // The realtime INSERT is missed if the tab was asleep, so also look for a call
  // that is ringing right now whenever the app is opened / brought to the front.
  async function checkPendingCalls() {
    if (!currentUser || activeCall || incomingCallPayload) return;
    try {
      const since = new Date(Date.now() - 40000).toISOString();
      const { data } = await supabaseClient.from('calls').select('*')
        .eq('receiver_id', currentUser.id)
        .eq('status', 'ringing')
        .gt('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1);
      if (data && data.length) showIncomingCallModal(data[0]);
    } catch (e) { console.warn('[calls] pending check failed', e); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkPendingCalls(); });
  window.addEventListener('focus', checkPendingCalls);

  // =====================================================================
  // 1-to-1 CALLS
  // =====================================================================
  function setStatus(t) { const el = $('callStatusText'); if (el) el.textContent = t || ''; }

  function showCallModal(type) {
    let modal = $('activeCallModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'activeCallModal';
      modal.className = 'call-modal';
      modal.innerHTML =
        '<div class="video-box">' +
          '<video id="remoteVideo" autoplay playsinline style="width:100%; height:100%; object-fit:cover;"></video>' +
          '<video id="localVideo" autoplay playsinline muted style="position:absolute; bottom:10px; right:10px; width:90px; height:120px; object-fit:cover; border-radius:10px; border:2px solid white;"></video>' +
        '</div>' +
        '<p id="callStatusText" style="color:white; margin-bottom:16px; min-height:1.2em;"></p>' +
        '<div style="display:flex; gap:10px;">' +
          '<button id="callFlipCameraBtn" class="btn-main" style="background:var(--card); border:1px solid var(--border); padding:10px 14px;" onclick="switchCamera(\'call\')">📸 Flip</button>' +
          '<button class="btn-main" style="background:var(--danger); max-width:200px;" onclick="endCall()">End Call</button>' +
        '</div>';
      document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
    const flipBtn = $('callFlipCameraBtn');
    const localVid = $('localVideo');
    if (type === 'audio') {
      if (localVid) localVid.style.display = 'none';
      if (flipBtn) flipBtn.style.display = 'none';
    } else {
      if (localVid) localVid.style.display = 'block';
      if (flipBtn) flipBtn.style.display = 'inline-block';
    }
  }

  async function newCallPeer() {
    const pc = new RTCPeerConnection({ iceServers: await getIceServers() });
    pc.ontrack = ev => {
      remoteStream = ev.streams[0] || new MediaStream([ev.track]);
      const rv = $('remoteVideo');
      if (rv) { rv.srcObject = remoteStream; rv.muted = false; rv.play().catch(() => {}); }
    };
    pc.oniceconnectionstatechange = () => console.log('[call] ice state:', pc.iceConnectionState);
    pc.onconnectionstatechange = () => {
      console.log('[call] connection state:', pc.connectionState);
      if (pc !== peerConnection) return;
      if (pc.connectionState === 'connected') setStatus('Connected');
      if (pc.connectionState === 'failed') {
        endCall(true, 'Call connection failed. This almost always means no TURN server is configured (see call-fixes.js).');
      }
    };
    return pc;
  }

  async function handleCallRow(c) {
    if (!c || !activeCall || activeCall.callId !== c.id) return;
    if (activeCall.isCaller && c.answer && c.status === 'answered' && peerConnection && !peerConnection.remoteDescription) {
      clearTimeout(activeCall.ringTimeout);
      setStatus('Connecting...');
      try { await peerConnection.setRemoteDescription(new RTCSessionDescription(asObj(c.answer))); }
      catch (e) { console.error('[call] setRemoteDescription(answer) failed', e); }
    }
    if (c.status === 'declined') endCall(false, 'Call declined');
    else if (c.status === 'ended') endCall(false);
  }

  function watchCall(callId) {
    if (callChannel) supabaseClient.removeChannel(callChannel);
    callChannel = supabaseClient
      .channel('call-' + callId)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls', filter: 'id=eq.' + callId },
        payload => handleCallRow(payload.new))
      .subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          // catch anything that happened before we were subscribed
          const { data } = await supabaseClient.from('calls').select('*').eq('id', callId).single();
          handleCallRow(data);
        }
      });
  }
  let callChannel = null;

  async function startCall(type) {
    if (!currentChatUser || activeCall) return;
    if (!navigator.mediaDevices) { alert('Camera/microphone need HTTPS.'); return; }
    const peerId = currentChatUser.id;
    activeCall = { type: type, peerId: peerId, isCaller: true, callId: null };
    showCallModal(type);
    setStatus('Calling...');

    try {
      localStream = await getMedia(type, currentFacingMode);
      $('localVideo').srcObject = localStream;

      peerConnection = await newCallPeer();
      localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await waitForIce(peerConnection);

      const { data: call, error } = await supabaseClient.from('calls').insert({
        caller_id: currentUser.id,
        receiver_id: peerId,
        call_type: type,
        offer: sdpJson(peerConnection.localDescription),
        status: 'ringing'
      }).select().single();
      if (error) throw error;
      if (!activeCall) return; // user hung up while we were setting up

      activeCall.callId = call.id;
      watchCall(call.id);

      supabaseClient.from('messages').insert({
        sender_id: currentUser.id,
        receiver_id: peerId,
        message: type.toUpperCase() + ' call initiated',
        is_call_log: true
      }).then(() => {});

      activeCall.ringTimeout = setTimeout(() => {
        if (activeCall && !peerConnection.remoteDescription) endCall(true, 'No answer');
      }, RING_TIMEOUT_MS);
    } catch (err) {
      console.error('[call] start failed', err);
      endCall(true, mediaErrorText(err));
    }
  }

  async function showIncomingCallModal(call) {
    if (incomingCallPayload && incomingCallPayload.id === call.id) return;
    if (activeCall) { // busy
      supabaseClient.from('calls').update({ status: 'declined' }).eq('id', call.id).then(() => {});
      return;
    }
    incomingCallPayload = call;
    $('incomingCallerName').textContent = 'Incoming ' + call.call_type + ' call';
    $('incomingCallType').textContent = 'Tap Accept to answer';
    $('incomingCallBox').style.display = 'block';
    startRingtone();
    setTimeout(() => {
      if (incomingCallPayload && incomingCallPayload.id === call.id) hideIncomingCall();
    }, RING_TIMEOUT_MS);

    try {
      const { data } = await supabaseClient.from('profiles').select('username, avatar_url').eq('id', call.caller_id).single();
      if (data && incomingCallPayload && incomingCallPayload.id === call.id) {
        $('incomingCallerName').textContent = data.username || 'Someone';
        $('incomingCallType').textContent = 'Incoming ' + call.call_type + ' call';
        if (data.avatar_url) $('incomingCallerAvatar').src = data.avatar_url;
      }
    } catch (e) { /* name is optional */ }
  }

  function hideIncomingCall() {
    stopRingtone();
    const box = $('incomingCallBox');
    if (box) box.style.display = 'none';
    incomingCallPayload = null;
  }

  async function acceptCall() {
    const call = incomingCallPayload;
    hideIncomingCall();
    if (!call || activeCall) return;
    if (!navigator.mediaDevices) { alert('Camera/microphone need HTTPS.'); return; }

    activeCall = { type: call.call_type, peerId: call.caller_id, isCaller: false, callId: call.id };
    showCallModal(call.call_type);
    setStatus('Connecting...');

    try {
      // make sure the call is still ringing and use the freshest offer
      const { data: fresh } = await supabaseClient.from('calls').select('status, offer').eq('id', call.id).single();
      if (!fresh || fresh.status !== 'ringing') { endCall(false, 'This call has already ended.'); return; }

      // getUserMedia is the first await-heavy step triggered by the Accept tap
      localStream = await getMedia(call.call_type, currentFacingMode);
      $('localVideo').srcObject = localStream;

      peerConnection = await newCallPeer();
      localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

      await peerConnection.setRemoteDescription(new RTCSessionDescription(asObj(fresh.offer)));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      await waitForIce(peerConnection);

      const { error } = await supabaseClient.from('calls')
        .update({ answer: sdpJson(peerConnection.localDescription), status: 'answered' })
        .eq('id', call.id);
      if (error) throw error;

      watchCall(call.id);
    } catch (err) {
      console.error('[call] accept failed', err);
      endCall(true, mediaErrorText(err));
    }
  }

  function declineCall() {
    const call = incomingCallPayload;
    hideIncomingCall();
    if (call) supabaseClient.from('calls').update({ status: 'declined' }).eq('id', call.id).then(() => {});
  }

  // notifyPeer = true  -> tell the other side the call is over
  function endCall(notifyPeer, message) {
    if (notifyPeer === undefined) notifyPeer = true;
    const call = activeCall;
    if (call && call.ringTimeout) clearTimeout(call.ringTimeout);
    if (notifyPeer && call && call.callId) {
      supabaseClient.from('calls').update({ status: 'ended' }).eq('id', call.callId).then(() => {});
    }
    if (callChannel) { supabaseClient.removeChannel(callChannel); callChannel = null; }
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
    }
    peerConnection = null; localStream = null; remoteStream = null; activeCall = null;
    const rv = $('remoteVideo'); if (rv) rv.srcObject = null;
    const modal = $('activeCallModal'); if (modal) modal.style.display = 'none';
    if (typeof message === 'string' && message) alert(message);
  }

  // =====================================================================
  // LIVE STREAMING  (host -> viewers, WebRTC, signalling over Supabase Realtime Broadcast)
  // Peer-to-peer, so good for roughly 5-8 viewers per host. For more, use LiveKit / Agora.
  // =====================================================================
  const livePeers = new Map(); // host side: viewerId -> RTCPeerConnection
  let liveChannel = null;
  let viewerPc = null;
  let watchingHostId = null;
  let liveRetryTimer = null;

  function sendLive(event, payload) {
    if (liveChannel) liveChannel.send({ type: 'broadcast', event: event, payload: payload });
  }
  function closeLiveChannel() {
    if (liveChannel) { supabaseClient.removeChannel(liveChannel); liveChannel = null; }
  }

  function removeUnmuteButton() { const b = $('liveUnmuteBtn'); if (b) b.remove(); }
  function showUnmuteButton() {
    if ($('liveUnmuteBtn')) return;
    const box = document.querySelector('.live-container');
    if (!box) return;
    const b = document.createElement('button');
    b.id = 'liveUnmuteBtn';
    b.className = 'btn-main';
    b.textContent = '🔊 Tap to hear the host';
    b.style.cssText = 'position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:auto; padding:12px 20px; z-index:20; background:var(--accent); color:black;';
    b.onclick = () => {
      const v = $('hostVideo');
      v.muted = false;
      v.play().catch(() => {});
      removeUnmuteButton();
    };
    box.appendChild(b);
  }
  function playLiveVideo() {
    const v = $('hostVideo');
    v.muted = false;
    v.play().then(removeUnmuteButton).catch(() => {
      v.muted = true;            // browsers only allow muted autoplay without a tap
      v.play().catch(() => {});
      showUnmuteButton();
    });
  }

  // ---------- host ----------
  function openHostChannel() {
    closeLiveChannel();
    liveChannel = supabaseClient.channel('live-' + currentUser.id);
    liveChannel
      .on('broadcast', { event: 'viewer-join' }, async ({ payload }) => {
        const viewerId = payload && payload.viewerId;
        if (!myStream || !viewerId) return;
        const old = livePeers.get(viewerId);
        if (old) { old.close(); livePeers.delete(viewerId); }

        const pc = new RTCPeerConnection({ iceServers: await getIceServers() });
        livePeers.set(viewerId, pc);
        myStream.getTracks().forEach(t => pc.addTrack(t, myStream));
        pc.onconnectionstatechange = () => {
          console.log('[live host] viewer', viewerId, pc.connectionState);
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            pc.close();
            if (livePeers.get(viewerId) === pc) livePeers.delete(viewerId);
          }
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIce(pc);
        sendLive('offer', { to: viewerId, sdp: sdpJson(pc.localDescription) });
      })
      .on('broadcast', { event: 'answer' }, async ({ payload }) => {
        const pc = livePeers.get(payload.from);
        if (pc && !pc.currentRemoteDescription) {
          try { await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp)); }
          catch (e) { console.error('[live host] bad answer', e); }
        }
      })
      .on('broadcast', { event: 'viewer-leave' }, ({ payload }) => {
        const pc = livePeers.get(payload.viewerId);
        if (pc) { pc.close(); livePeers.delete(payload.viewerId); }
      })
      .subscribe();
  }

  async function toggleGroupStream() {
    const btn = $('btnStreamToggle');
    const giftBtn = $('streamGiftBtn');
    const badge = $('liveBadgeEl');
    const hostVideo = $('hostVideo');

    if (!isStreaming) {
      try {
        if (!navigator.mediaDevices) { alert('Camera/microphone need HTTPS.'); return; }
        if (watchingHostId) leaveLive();
        myStream = await getMedia('video', currentFacingMode);
        if (!myStream.getAudioTracks().length) {
          alert('Warning: no microphone was captured, viewers will not hear you.');
        }
        hostVideo.srcObject = myStream;
        hostVideo.muted = true;          // only mutes YOUR preview (prevents echo); viewers get the audio
        hostVideo.play().catch(() => {});
        removeUnmuteButton();

        isStreaming = true;
        btn.innerText = 'Stop Live';
        btn.style.background = 'var(--danger)';
        if (giftBtn) giftBtn.style.display = 'none';
        if (badge) badge.style.display = 'none';

        const upd = await supabaseClient.from('livestreams')
          .update({ is_active: true }).eq('user_id', currentUser.id).select();
        if (!upd.data || !upd.data.length) {
          await supabaseClient.from('livestreams').insert({ user_id: currentUser.id, is_active: true });
        }
        openHostChannel();
      } catch (err) {
        console.error('[live] start failed', err);
        if (myStream) myStream.getTracks().forEach(t => t.stop());
        isStreaming = false;
        alert(mediaErrorText(err));
      }
    } else {
      sendLive('ended', {});
      livePeers.forEach(pc => pc.close());
      livePeers.clear();
      setTimeout(closeLiveChannel, 500);

      if (myStream) myStream.getTracks().forEach(t => t.stop());
      myStream = null;
      hostVideo.srcObject = null;
      isStreaming = false;
      btn.innerText = 'Start Live';
      btn.style.background = 'var(--primary)';
      if (giftBtn) giftBtn.style.display = 'flex';
      if (badge) badge.style.display = 'none';

      await supabaseClient.from('livestreams').update({ is_active: false }).eq('user_id', currentUser.id);
    }
  }

  // ---------- viewer ----------
  function leaveLive() {
    clearTimeout(liveRetryTimer);
    if (watchingHostId) {
      sendLive('viewer-leave', { viewerId: currentUser.id });
      const ch = liveChannel; liveChannel = null;
      setTimeout(() => { if (ch) supabaseClient.removeChannel(ch); }, 300);
    }
    if (viewerPc) { viewerPc.close(); viewerPc = null; }
    watchingHostId = null;
    removeUnmuteButton();
    const v = $('hostVideo');
    if (v && !isStreaming) v.srcObject = null;
  }

  function joinLiveStream(streamId) {
    const item = (globalLiveStreams || []).find(s => String(s.id) === String(streamId));
    const hostId = item && item.user_id;
    const nav = document.querySelectorAll('.nav-item')[1];
    if (!hostId) { alert('This live stream is not available.'); return; }
    if (isStreaming || hostId === currentUser.id) { switchTab('liveTab', nav); return; }

    const giftBtn = $('streamGiftBtn');
    const badge = $('liveBadgeEl');
    if (giftBtn) giftBtn.style.display = 'flex';
    if (badge) badge.style.display = 'block';
    switchTab('liveTab', nav);

    leaveLive();
    watchingHostId = hostId;
    const video = $('hostVideo');
    video.muted = false;

    liveChannel = supabaseClient.channel('live-' + hostId);
    liveChannel
      .on('broadcast', { event: 'offer' }, async ({ payload }) => {
        if (!payload || payload.to !== currentUser.id || watchingHostId !== hostId) return;
        if (viewerPc) viewerPc.close();
        const pc = new RTCPeerConnection({ iceServers: await getIceServers() });
        viewerPc = pc;
        pc.ontrack = ev => {
          video.srcObject = ev.streams[0] || new MediaStream([ev.track]);
          playLiveVideo();
        };
        pc.onconnectionstatechange = () => {
          console.log('[live viewer] connection state:', pc.connectionState);
          if (pc.connectionState === 'failed' && pc === viewerPc) {
            leaveLive();
            alert('Could not connect to the live stream. This usually means no TURN server is configured.');
          }
        };
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIce(pc);
        sendLive('answer', { from: currentUser.id, sdp: sdpJson(pc.localDescription) });
      })
      .on('broadcast', { event: 'ended' }, () => {
        leaveLive();
        alert('The live stream has ended.');
      })
      .subscribe(status => {
        if (status !== 'SUBSCRIBED') return;
        const attempt = n => {
          if (watchingHostId !== hostId || viewerPc) return;
          if (n > 3) { leaveLive(); alert('The host is not available right now.'); return; }
          sendLive('viewer-join', { viewerId: currentUser.id });
          liveRetryTimer = setTimeout(() => attempt(n + 1), 6000);
        };
        attempt(1);
      });
  }

  // =====================================================================
  // Camera flip (works for calls and for the live stream)
  // =====================================================================
  function swapTracks(pcs, stream) {
    pcs.forEach(pc => pc.getSenders().forEach(s => {
      if (!s.track) return;
      const nt = stream.getTracks().find(t => t.kind === s.track.kind);
      if (nt) s.replaceTrack(nt).catch(console.error);
    }));
  }

  async function switchCamera(mode) {
    const next = currentFacingMode === 'user' ? 'environment' : 'user';
    try {
      if (mode === 'stream' && isStreaming) {
        const s = await getMedia('video', next);
        currentFacingMode = next;
        swapTracks(Array.from(livePeers.values()), s);
        if (myStream) myStream.getTracks().forEach(t => t.stop());
        myStream = s;
        const hv = $('hostVideo'); hv.srcObject = s; hv.muted = true;
      } else if (mode === 'call' && localStream && activeCall && activeCall.type === 'video') {
        const s = await getMedia('video', next);
        currentFacingMode = next;
        if (peerConnection) swapTracks([peerConnection], s);
        localStream.getTracks().forEach(t => t.stop());
        localStream = s;
        $('localVideo').srcObject = s;
      }
    } catch (e) {
      console.error(e);
      alert('Could not switch camera.');
    }
  }

  // =====================================================================
  // Call alerts when the app is closed (Web Push)
  // =====================================================================
  let swListenerAdded = false;
  async function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('/sw.js');
      if (!swListenerAdded) {
        swListenerAdded = true;
        navigator.serviceWorker.addEventListener('message', e => { if (e.data === 'check-calls') checkPendingCalls(); });
      }
    } catch (e) { console.warn('[push] service worker registration failed', e); }
  }

  function urlB64ToUint8Array(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  async function enableCallAlerts() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      alert('Notifications are not supported in this browser.\n\niPhone: open the site in Safari, tap Share > Add to Home Screen, open it from the Home Screen, then try again (iOS 16.4+).');
      return;
    }
    if (!VAPID_PUBLIC_KEY) { alert('VAPID_PUBLIC_KEY is not set in call-fixes.js yet.'); return; }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { alert('Notifications are blocked. Allow them in your browser/site settings, then try again.'); return; }
      await registerSW();
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY)
        });
      }
      const { error } = await supabaseClient.from('push_subscriptions').upsert(
        { user_id: currentUser.id, endpoint: sub.endpoint, subscription: sub.toJSON() },
        { onConflict: 'endpoint' }
      );
      if (error) throw error;
      alert('Call alerts are now enabled on this device.');
    } catch (e) {
      console.error('[push] enable failed', e);
      alert('Could not enable call alerts: ' + (e.message || e));
    }
  }

  // =====================================================================
  // Install overrides
  // =====================================================================
  const _initApp = window.initApp;
  const _switchTab = window.switchTab;
  const _openSettings = window.openSettings;

  window.setupRealtimeListeners = setupRealtimeListeners;
  window.checkPendingCalls = checkPendingCalls;
  window.showCallModal = showCallModal;
  window.startCall = startCall;
  window.showIncomingCallModal = showIncomingCallModal;
  window.acceptCall = acceptCall;
  window.declineCall = declineCall;
  window.endCall = endCall;
  window.toggleGroupStream = toggleGroupStream;
  window.joinLiveStream = joinLiveStream;
  window.switchCamera = switchCamera;
  window.enableCallAlerts = enableCallAlerts;

  window.initApp = async function () {
    await _initApp.apply(this, arguments);
    registerSW();
    checkPendingCalls();
  };

  window.switchTab = function (tabId) {
    if (tabId !== 'liveTab' && watchingHostId) leaveLive();
    return _switchTab.apply(this, arguments);
  };

  window.openSettings = function (type) {
    _openSettings.apply(this, arguments);
    if (type === 'notifications') {
      $('settingsBody').innerHTML =
        '<p style="font-size:0.85rem; color:var(--text-dim); margin-bottom:12px;">Get a notification when someone calls you, even when the app is closed.</p>' +
        '<button class="btn-main" onclick="enableCallAlerts()">🔔 Enable call alerts on this device</button>' +
        '<div class="setting-row" style="margin-top:12px;"><span>Live Stream Alerts</span><input type="checkbox" checked></div>';
    }
  };

  console.log('[call-fixes] loaded');
})();
