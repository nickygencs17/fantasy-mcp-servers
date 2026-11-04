// Runs in the user's own ESPN draft-room tab via the "Draft Bridge" bookmarklet
// (make_bookmarklet.py), with room_bridge.py running on the Mac. ESPN's API
// hides live picks until the draft ends and allows only one draft-room
// connection per person, so this reads the user's own draft room every 2
// seconds and posts the picks to the local bridge, which saves
// draft-cache/room-<league>.json for pick.py. On the user's turn the bridge
// replies with the pick, shown in a box on the draft page. Running it again
// just reports status (it won't double-install).
//
// Reads the page text: the on-the-clock pick, the scrolling "Picks" feed
// ("Name / TEAM POS" then "R2, P6 - Fantasy Team"), the Pick History table
// when it's showing, and the roster panel (plus which team it's showing, when
// the page has that as a dropdown). Picks accumulate on window.__draftRoom, so
// nothing is lost when the feed scrolls past older picks.
(() => {
  const BRIDGE = 'http://127.0.0.1:8781/picks';
  const league = new URLSearchParams(location.search).get('leagueId');
  const state = (window.__draftRoom ||= { byRound: {}, byOverall: {}, posts: 0, errors: 0 });
  const POS = '(?:QB|RB|WR|TE|K|D/ST)';
  // Before the draft the player list's buttons ("QUEUE", "DRAFT") look like
  // pick rows; never treat them as a team or a player.
  const NOT_TEAM = /^(QUEUE|DRAFT|ADD|REMOVE)$/;
  const feed = new RegExp(`\\n([^\\n]+?) / [A-Z]{2,3} ${POS}\\nR(\\d+), P(\\d+) - ([^\\n]+)`, 'g');
  const table = new RegExp(`\\n(\\d{1,3})\\n([^\\n]+)\\n(?:[A-Z]{1,4}\\n)?[A-Z]{2,3}\\n${POS}\\n([^\\n]+)\\n[\\d.]+\\n`, 'g');

  // Which team the roster panel is showing: the selected option of a team
  // dropdown, if the page uses one (pick.py also sanity-checks the panel).
  const rosterTeam = () => {
    for (const sel of document.querySelectorAll('select')) {
      const texts = [...sel.options].map(o => o.text);
      if (texts.length >= 4 && texts.filter(t => /team/i.test(t)).length >= 2) return sel.options[sel.selectedIndex]?.text || null;
    }
    return null;
  };

  const read = () => {
    const text = document.body.innerText;
    for (const m of text.matchAll(feed)) if (!NOT_TEAM.test(m[4].trim())) state.byRound[`${m[2]}.${m[3]}`] = [Number(m[2]), Number(m[3]), m[1].trim(), m[4].trim()];
    for (const m of text.matchAll(table)) if (!NOT_TEAM.test(m[3].trim())) state.byOverall[m[1]] = [Number(m[1]), m[2].trim(), m[3].trim()];
    // Roster panel: "RB\n\t\nC. Brown\n\t\n6", bench rows add the position:
    // "BE\n\t\nG. Pickens\n(WR)\n\t\n14"
    const roster = [...text.matchAll(/\n(QB|RB|WR|TE|FLEX|D\/ST|K|BE)\n\t?\n?([^\n\t]+)\n(?:\(([A-Z\/]+)\)\n)?\t?\n?(\d+|-)\n/g)]
      .map(m => [m[3] || m[1], m[2].trim()]).filter(([, name]) => name !== 'Empty' && !NOT_TEAM.test(name));
    return {
      league,
      roster,
      roster_team: rosterTeam(),
      clock: Number((text.match(/ON THE CLOCK: PICK (\d+)/) || [])[1]) || null,
      my_turn: /You are on the clock!/.test(text),
      feed: Object.values(state.byRound),
      history: Object.values(state.byOverall),
      read_at: Date.now(),
    };
  };

  // On-page recommendation box, shown only while it's the user's turn
  const show = (reply) => {
    let box = document.getElementById('__draftBridgePick');
    if (!reply || !reply.take) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      box.id = '__draftBridgePick';
      Object.assign(box.style, { position: 'fixed', top: '90px', right: '16px', zIndex: 99999, maxWidth: '380px',
        background: '#0a7d3e', color: '#fff', padding: '12px 14px', borderRadius: '10px',
        font: '14px/1.35 system-ui, sans-serif', boxShadow: '0 4px 16px rgba(0,0,0,.35)' });
      document.body.appendChild(box);
    }
    const [name, ...why] = reply.take.split(' — ');
    box.innerHTML = '';
    const title = document.createElement('div');
    title.style.font = '700 17px system-ui, sans-serif';
    title.textContent = 'TAKE: ' + name;
    const detail = document.createElement('div');
    detail.style.opacity = '.9';
    detail.textContent = why.join(' — ');
    box.append(title, detail);
    if (reply.next) {
      const next = document.createElement('div');
      next.style.marginTop = '6px';
      next.textContent = 'Next best: ' + reply.next.split(' — ')[0];
      box.append(next);
    }
  };

  const post = () => fetch(BRIDGE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(read()) })
    .then(r => r.ok ? r.json() : null)
    .then(reply => { state.posts++; state.lastError = null; show(reply); })
    .catch(e => { state.errors++; state.lastError = String(e); });

  // Take over from an older copy of the reader already running in this tab
  const VERSION = 3;
  if (state.timer && state.version !== VERSION) { clearInterval(state.timer); state.timer = null; }
  if (!state.timer) {
    state.version = VERSION;
    state.timer = setInterval(post, 2000);
    post();
  }
  const snap = read();
  return `installed for league ${league} (pick ${snap.clock || 'not started'}, ${snap.feed.length + snap.history.length} picks seen, ${state.posts} sent${state.lastError ? ', last error: ' + state.lastError : ''})`;
})()
