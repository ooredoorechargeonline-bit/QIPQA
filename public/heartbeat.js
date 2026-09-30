// Heartbeat script for tracking active visitors
(function() {
  var sessionId = sessionStorage.getItem('qic_session_id');
  if (!sessionId) {
    sessionId = 'sess_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    sessionStorage.setItem('qic_session_id', sessionId);
  }

  var page = window.location.pathname.split('/').pop() || 'index.html';
  var lang = document.documentElement.lang || 'ar';

  function sendHeartbeat() {
    fetch('/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId,
        page: page,
        lang: lang
      })
    }).catch(function(){});
  }

  // Send immediately
  sendHeartbeat();
  // Then every 5 seconds
  setInterval(sendHeartbeat, 5000);

  // Send when tab becomes visible
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) sendHeartbeat();
  });
})();
