// ── Constants ──────────────────────────────────────────────────────────────
const WS_URL = 'wss://rummy-game.stephengale.partykit.dev/party/main';

const RANK_LABEL = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const SUIT_SYMBOL = { H: '♥', D: '♦', C: '♣', S: '♠' };
const SUIT_COLOR  = { H: 'red', D: 'red', C: 'black', S: 'black' };

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  screen: 'splash',
  myName: null,
  ws: null,
  game: null,            // current game view from server
  selectedIds: new Set(),
  layoffMode: false,
  toastTimer: null,
  countdownTimer: null,
  handOrder: [],         // local display order of card IDs
};

let dragState = null;

// ── Screens ────────────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  state.screen = name;

  if (name === 'select' && (!state.ws || state.ws.readyState > WebSocket.OPEN)) {
    connect();
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────
function connect() {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }

  const ws = new WebSocket(WS_URL);
  state.ws = ws;

  ws.onopen = () => {
    if (state.myName) {
      send({ type: 'join', player: state.myName });
    }
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMsg(msg);
  };

  ws.onclose = () => {
    setTimeout(() => {
      if (state.myName) connect(); // auto-reconnect if we had a player name
    }, 2000);
  };

  ws.onerror = () => ws.close();
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

// ── Server message handler ─────────────────────────────────────────────────
function handleServerMsg(msg) {
  if (msg.type === 'error') {
    showToast(msg.message);
    // If join was rejected because the avatar is taken, clear our local selection
    if (msg.message === 'That avatar is already taken') {
      state.myName = null;
      if (state.screen === 'select') renderSelect();
    }
    return;
  }

  if (msg.type === 'end_game') {
    doEndGame();
    return;
  }

  if (msg.type === 'state') {
    const prev = state.game;
    state.game = msg.state;
    if (msg.state.myHand) syncHandOrder(msg.state.myHand);
    reconcileScreen(prev);
    render();
  }
}

function reconcileScreen(prev) {
  const g = state.game;
  if (!g) return;

  const phase = g.phase;

  if (phase === 'finished') {
    showScreen('finish');
    return;
  }

  if (phase === 'playing' || phase === 'round_over') {
    // Server doesn't recognise our connection — resend join so it can identify us
    if (!g.myName && state.myName) {
      send({ type: 'join', player: state.myName });
      return;
    }
    if (g.myName && state.screen !== 'game') {
      showScreen('game');
    }
    if (phase === 'round_over') {
      showRoundOverlay();
    } else {
      hideRoundOverlay();
    }
    if (prev?.phase === 'round_over' && phase === 'playing') {
      state.selectedIds.clear();
      state.layoffMode = false;
      state.handOrder = [];
    }
    return;
  }

  // phase === 'waiting'
  if (state.screen !== 'select') showScreen('select');
  hideRoundOverlay();
}

// ── Top-level render ───────────────────────────────────────────────────────
function render() {
  const s = state.screen;
  if (s === 'select')  renderSelect();
  if (s === 'game')    renderGame();
  if (s === 'finish')  renderFinish();
}

// ── SELECT screen ──────────────────────────────────────────────────────────
function renderSelect() {
  const g = state.game;
  const statusEl = document.getElementById('select-status');
  const connectionsEl = document.getElementById('select-connections');

  // Not yet connected to server — disable all buttons and show loading state
  if (!g) {
    document.querySelectorAll('.btn-player').forEach(btn => {
      btn.disabled = true;
      btn.classList.remove('selected', 'connected');
      const tag = btn.querySelector('.player-tag');
      if (tag) tag.textContent = '';
    });
    if (connectionsEl) connectionsEl.textContent = '';
    statusEl.textContent = 'Connecting to Wonderland…';
    return;
  }

  const connected = g.connectedPlayers || [];
  const other = state.myName === 'Tas' ? 'Steve' : 'Tas';

  document.querySelectorAll('.btn-player').forEach(btn => {
    const playerName = btn.dataset.player;
    const isMe = state.myName === playerName;
    const isOtherConnected = connected.includes(playerName) && !isMe;
    const tag = btn.querySelector('.player-tag');

    btn.classList.toggle('selected', isMe);
    btn.classList.toggle('connected', isOtherConnected);
    // Disable the button if the other player already claimed it,
    // or if we've already chosen and this isn't our button
    btn.disabled = isOtherConnected || Boolean(state.myName && !isMe);

    if (tag) tag.textContent = isOtherConnected ? 'Connected' : '';
  });

  if (connectionsEl) {
    connectionsEl.textContent = connected.length > 0
      ? `${connected.length} / 2 connected`
      : '';
  }

  if (!state.myName) {
    statusEl.textContent = 'Choose your character to begin.';
    return;
  }

  if (connected.length < 2) {
    statusEl.textContent = `Waiting for ${other} to join…`;
    return;
  }

  statusEl.textContent = 'Both players connected — starting game…';
}

// ── GAME screen ────────────────────────────────────────────────────────────
function renderGame() {
  const g = state.game;
  if (!g) return;

  const opponentName = state.myName === 'Tas' ? 'Steve' : 'Tas';

  // Scores & names
  document.getElementById('opponent-name').textContent = opponentName;
  document.getElementById('opponent-score').textContent = (g.scores?.[opponentName] ?? 0);
  document.getElementById('my-name').textContent = state.myName || 'You';
  document.getElementById('my-score').textContent = (g.scores?.[state.myName] ?? 0);

  renderOpponentHand();
  renderPiles();
  renderMelds();
  renderPlayerHand();
  renderActionBar();
}

function renderOpponentHand() {
  const g = state.game;
  const el = document.getElementById('opponent-hand');
  el.innerHTML = '';
  const count = g.opponentHandCount ?? 0;
  // Show up to 10 small face-down cards, plus a label if more
  const show = Math.min(count, 12);
  for (let i = 0; i < show; i++) {
    const c = document.createElement('div');
    c.className = 'card card-back small';
    el.appendChild(c);
  }
  if (count > 12) {
    const lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:0.75rem;color:rgba(255,255,255,0.5);align-self:center;margin-left:2px;';
    lbl.textContent = `+${count - 12}`;
    el.appendChild(lbl);
  }
}

function renderPiles() {
  const g = state.game;
  const isMyTurn = g.currentTurn === state.myName;
  const isDraw = g.turnPhase === 'draw';

  // Stock
  const stockPile = document.getElementById('stock-pile');
  const stockCard = document.getElementById('stock-card');
  document.getElementById('stock-count').textContent = g.stockCount ?? 0;

  stockPile.onclick = null;
  stockCard.classList.remove('pile-clickable');
  if (isMyTurn && isDraw && g.stockCount > 0) {
    stockCard.classList.add('pile-clickable');
    stockPile.style.cursor = 'pointer';
    stockPile.onclick = () => send({ type: 'draw', from: 'stock' });
  } else {
    stockPile.style.cursor = 'default';
  }

  // Discard
  const discardPile = document.getElementById('discard-pile');
  const discardTop = document.getElementById('discard-top');
  discardTop.onclick = null;

  const topCard = g.discardPile && g.discardPile.length > 0
    ? g.discardPile[g.discardPile.length - 1]
    : null;

  // Replace the discard-top element with a fresh one to avoid stale handlers
  const newDiscardTop = topCard
    ? makeCardEl(topCard, { small: false })
    : (() => {
        const d = document.createElement('div');
        d.className = 'card pile-card empty-pile';
        d.innerHTML = '<span class="empty-label">Discard</span>';
        return d;
      })();
  newDiscardTop.id = 'discard-top';
  discardTop.replaceWith(newDiscardTop);

  if (topCard && isMyTurn && isDraw) {
    newDiscardTop.classList.add('pile-clickable');
    newDiscardTop.style.cursor = 'pointer';
    newDiscardTop.onclick = () => send({ type: 'draw', from: 'discard' });
  }
}

function renderMelds() {
  const g = state.game;
  const el = document.getElementById('melds-area');
  el.innerHTML = '';

  const emptyMsg = document.createElement('p');
  emptyMsg.className = 'melds-empty';
  emptyMsg.id = 'melds-empty';
  emptyMsg.textContent = 'No melds yet';

  if (!g.melds || g.melds.length === 0) {
    el.appendChild(emptyMsg);
    return;
  }

  for (const meld of g.melds) {
    const meldEl = document.createElement('div');
    meldEl.className = 'meld';
    meldEl.dataset.meldId = meld.id;

    for (const card of meld.cards) {
      meldEl.appendChild(makeCardEl(card));
    }

    if (state.layoffMode) {
      meldEl.classList.add('layoff-target');
      meldEl.onclick = () => confirmLayoff(meld.id);
    }

    el.appendChild(meldEl);
  }
}

function renderPlayerHand() {
  if (dragState?.moved) return; // don't interrupt an active drag

  const g = state.game;
  const el = document.getElementById('player-hand');
  el.innerHTML = '';
  if (!g.myHand) return;

  const isMyTurn = g.currentTurn === state.myName;
  const isDiscard = g.turnPhase === 'discard';
  const isAction = g.turnPhase === 'action';

  const ordered = [...g.myHand].sort((a, b) => {
    const ai = state.handOrder.indexOf(a.id);
    const bi = state.handOrder.indexOf(b.id);
    return ai - bi;
  });

  for (const card of ordered) {
    const cardEl = makeCardEl(card);

    const isNoDiscard = isMyTurn && isDiscard && card.id === g.drawnFromDiscardId;

    if (isNoDiscard) {
      cardEl.classList.add('no-discard');
    } else if (isMyTurn && isDiscard) {
      cardEl.classList.add('discardable');
      cardEl.onclick = () => send({ type: 'discard', cardId: card.id });
    } else if (isMyTurn && isAction) {
      cardEl.classList.add('selectable');
      if (state.selectedIds.has(card.id)) cardEl.classList.add('selected');
      cardEl.onclick = () => toggleSelect(card.id);
    }

    addDragToCard(cardEl, card.id);
    el.appendChild(cardEl);
  }
}

function renderActionBar() {
  const g = state.game;
  const statusEl = document.getElementById('turn-status');
  const buttonsEl = document.getElementById('action-buttons');
  buttonsEl.innerHTML = '';

  if (!g || g.phase === 'waiting') {
    statusEl.textContent = 'Waiting for players…';
    return;
  }

  if (g.phase === 'round_over' || g.phase === 'finished') {
    statusEl.textContent = '';
    return;
  }

  const isMyTurn = g.currentTurn === state.myName;
  const opponentName = state.myName === 'Tas' ? 'Steve' : 'Tas';

  if (state.layoffMode) {
    statusEl.textContent = 'Tap a meld above to lay off onto it';
    const cancel = makeBtn('Cancel', 'btn-cancel', () => exitLayoffMode());
    buttonsEl.appendChild(cancel);
    return;
  }

  if (!isMyTurn) {
    statusEl.textContent = `${opponentName}'s turn…`;
    return;
  }

  if (g.turnPhase === 'draw') {
    statusEl.textContent = 'Tap Stock or Discard to draw';
    return;
  }

  if (g.turnPhase === 'action') {
    statusEl.textContent = 'Meld, lay off, or tap Done';
    const sel = [...state.selectedIds];

    if (sel.length >= 3) {
      buttonsEl.appendChild(makeBtn('Meld', 'btn-meld', () => {
        send({ type: 'meld', cardIds: sel });
        state.selectedIds.clear();
      }));
    }

    if (sel.length >= 1 && g.melds && g.melds.length > 0) {
      buttonsEl.appendChild(makeBtn('Lay Off', 'btn-layoff', () => enterLayoffMode()));
    }

    buttonsEl.appendChild(makeBtn('Done', 'btn-done', () => {
      send({ type: 'done_action' });
      state.selectedIds.clear();
    }));
    return;
  }

  if (g.turnPhase === 'discard') {
    statusEl.textContent = 'Tap a card in your hand to discard';
  }
}

// ── FINISH screen ──────────────────────────────────────────────────────────
function renderFinish() {
  const g = state.game;
  if (!g) return;

  document.getElementById('finish-title').textContent =
    g.winner === state.myName ? 'Off with their heads! You win!' : `${g.winner} wins the game!`;
  document.getElementById('finish-subtitle').textContent =
    g.winner === state.myName
      ? 'The Queen of Hearts is pleased.'
      : 'Better luck next time, curiouser and curiouser…';

  const scoresEl = document.getElementById('final-scores');
  scoresEl.innerHTML = '';
  for (const [name, score] of Object.entries(g.scores ?? {})) {
    const block = document.createElement('div');
    block.className = 'score-block';
    block.innerHTML = `<span class="score-block-name">${name}</span><span class="score-block-value">${score}</span>`;
    scoresEl.appendChild(block);
  }
}

// ── Round overlay ──────────────────────────────────────────────────────────
function showRoundOverlay() {
  const g = state.game;
  const overlay = document.getElementById('round-overlay');
  overlay.classList.remove('hidden');

  const summary = g.lastRoundSummary;
  const iconEl = document.getElementById('overlay-icon');
  const titleEl = document.getElementById('overlay-title');
  const msgEl = document.getElementById('overlay-message');
  const scoresEl = document.getElementById('overlay-scores');
  const countdownEl = document.getElementById('overlay-countdown');

  if (!summary) return;

  if (summary.isDraw) {
    iconEl.textContent = '🃏';
    titleEl.textContent = 'Round Draw!';
    msgEl.textContent = 'The stock ran out. No points awarded.';
  } else {
    const iWon = summary.winner === state.myName;
    iconEl.textContent = iWon ? '🎉' : '😔';
    titleEl.textContent = iWon ? 'You won the round!' : `${summary.winner} won the round!`;
    msgEl.textContent = `+${summary.points} points`;
  }

  // Scores
  scoresEl.innerHTML = '';
  for (const [name, score] of Object.entries(g.scores ?? {})) {
    const block = document.createElement('div');
    block.className = 'score-block';
    block.innerHTML = `<span class="score-block-name">${name}</span><span class="score-block-value">${score}</span>`;
    scoresEl.appendChild(block);
  }

  // Countdown
  let secs = 5;
  clearInterval(state.countdownTimer);
  countdownEl.textContent = `Next round in ${secs}…`;
  state.countdownTimer = setInterval(() => {
    secs--;
    if (secs <= 0) {
      clearInterval(state.countdownTimer);
      countdownEl.textContent = 'Starting…';
    } else {
      countdownEl.textContent = `Next round in ${secs}…`;
    }
  }, 1000);
}

function hideRoundOverlay() {
  document.getElementById('round-overlay').classList.add('hidden');
  clearInterval(state.countdownTimer);
}

// ── Card factory ───────────────────────────────────────────────────────────
function makeCardEl(card, opts = {}) {
  const el = document.createElement('div');
  const color = SUIT_COLOR[card.suit] ?? 'black';
  el.className = `card ${color}`;
  el.dataset.cardId = card.id;

  const rank = RANK_LABEL[card.rank] ?? String(card.rank);
  const suit = SUIT_SYMBOL[card.suit] ?? '?';

  el.innerHTML = `
    <span class="card-rank top">${rank}</span>
    <span class="card-suit-center">${suit}</span>
    <span class="card-rank bottom">${rank}</span>
  `;
  return el;
}

function makeMiniCardEl(card) {
  const el = document.createElement('div');
  el.className = `card-mini ${SUIT_COLOR[card.suit] ?? 'black'}`;
  const rank = RANK_LABEL[card.rank] ?? String(card.rank);
  const suit = SUIT_SYMBOL[card.suit] ?? '?';
  el.innerHTML = `<span>${rank}</span><span>${suit}</span>`;
  return el;
}

// ── Hand order sync ────────────────────────────────────────────────────────
function syncHandOrder(serverHand) {
  const serverIds = serverHand.map(c => c.id);
  const kept = state.handOrder.filter(id => serverIds.includes(id));
  const added = serverIds.filter(id => !kept.includes(id));
  state.handOrder = [...kept, ...added];
}

// ── Hand drag-to-reorder ────────────────────────────────────────────────────
function addDragToCard(cardEl, cardId) {
  cardEl.addEventListener('pointerdown', (e) => startDrag(e, cardId), { passive: true });
}

function startDrag(e, cardId) {
  const handEl = document.getElementById('player-hand');
  const cardEl = handEl.querySelector(`[data-card-id="${cardId}"]`);
  if (!cardEl) return;
  const rect = cardEl.getBoundingClientRect();
  dragState = {
    cardId,
    startX: e.clientX,
    startY: e.clientY,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    moved: false,
    ghost: null,
    lastInsertBefore: undefined,
  };
  document.addEventListener('pointermove', onDragMove, { passive: true });
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragEnd);
}

function onDragMove(e) {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;

  if (!dragState.moved) {
    if (Math.hypot(dx, dy) < 8) return;
    dragState.moved = true;

    const handEl = document.getElementById('player-hand');
    const cardEl = handEl.querySelector(`[data-card-id="${dragState.cardId}"]`);
    if (!cardEl) return;

    const ghost = cardEl.cloneNode(true);
    ghost.style.cssText = `
      position:fixed; pointer-events:none; z-index:1000;
      opacity:0.9; transform:rotate(4deg) scale(1.08);
      width:${cardEl.offsetWidth}px; height:${cardEl.offsetHeight}px;
      left:${e.clientX - dragState.offsetX}px;
      top:${e.clientY - dragState.offsetY}px;
      box-shadow:0 8px 24px rgba(0,0,0,0.55);
    `;
    document.body.appendChild(ghost);
    dragState.ghost = ghost;
    cardEl.style.opacity = '0.25';
    handEl.closest('.hand-scroll-wrap').style.overflowX = 'hidden';
  }

  if (!dragState.ghost) return;

  dragState.ghost.style.left = `${e.clientX - dragState.offsetX}px`;
  dragState.ghost.style.top  = `${e.clientY - dragState.offsetY}px`;

  const insertBefore = getDragInsertTarget(e.clientX);
  if (insertBefore !== dragState.lastInsertBefore) {
    dragState.lastInsertBefore = insertBefore;
    reorderHandDOM(dragState.cardId, insertBefore);
  }
}

function getDragInsertTarget(clientX) {
  const handEl = document.getElementById('player-hand');
  for (const c of handEl.querySelectorAll('.card[data-card-id]')) {
    if (c.dataset.cardId === dragState.cardId) continue;
    const rect = c.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return c.dataset.cardId;
  }
  return null;
}

function reorderHandDOM(dragCardId, insertBeforeId) {
  const handEl = document.getElementById('player-hand');
  const dragEl = handEl.querySelector(`[data-card-id="${dragCardId}"]`);
  if (!dragEl) return;
  if (insertBeforeId) {
    const beforeEl = handEl.querySelector(`[data-card-id="${insertBeforeId}"]`);
    if (beforeEl) handEl.insertBefore(dragEl, beforeEl);
  } else {
    handEl.appendChild(dragEl);
  }
}

function onDragEnd() {
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', onDragEnd);

  if (!dragState) return;

  if (dragState.moved) {
    dragState.ghost?.remove();
    const handEl = document.getElementById('player-hand');
    handEl.closest('.hand-scroll-wrap').style.overflowX = '';
    state.handOrder = [...handEl.querySelectorAll('.card[data-card-id]')]
      .map(c => c.dataset.cardId);
    // Swallow the synthetic click that follows pointerup
    document.addEventListener('click', e => e.stopPropagation(), { capture: true, once: true });
    dragState = null;
    renderPlayerHand();
    renderActionBar();
  } else {
    dragState = null;
  }
}

// ── Selection ──────────────────────────────────────────────────────────────
function toggleSelect(cardId) {
  if (state.selectedIds.has(cardId)) {
    state.selectedIds.delete(cardId);
  } else {
    state.selectedIds.add(cardId);
  }
  renderPlayerHand();
  renderActionBar();
}

// ── Lay off mode ───────────────────────────────────────────────────────────
function enterLayoffMode() {
  const g = state.game;
  if (!g || !g.melds || g.melds.length === 0) {
    showToast('No melds on the table yet');
    return;
  }

  // Show modal with meld choices
  const modal = document.getElementById('layoff-modal');
  const choicesEl = document.getElementById('meld-choices');
  choicesEl.innerHTML = '';

  for (const meld of g.melds) {
    const btn = document.createElement('button');
    btn.className = 'meld-choice-btn';
    btn.onclick = () => {
      confirmLayoff(meld.id);
      modal.classList.add('hidden');
    };
    for (const card of meld.cards) {
      btn.appendChild(makeMiniCardEl(card));
    }
    choicesEl.appendChild(btn);
  }

  modal.classList.remove('hidden');
  state.layoffMode = true;
}

function exitLayoffMode() {
  state.layoffMode = false;
  document.getElementById('layoff-modal').classList.add('hidden');
  renderMelds();
  renderActionBar();
}

function confirmLayoff(meldId) {
  const selected = [...state.selectedIds];
  send({ type: 'layoff', cardIds: selected, meldId });
  state.selectedIds.clear();
  state.layoffMode = false;
  document.getElementById('layoff-modal').classList.add('hidden');
}

// ── Button helper ──────────────────────────────────────────────────────────
function makeBtn(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.className = `btn-action ${cls}`;
  btn.textContent = label;
  btn.onclick = onClick;
  return btn;
}

// ── End Game ───────────────────────────────────────────────────────────────
function doEndGame() {
  state.myName = null;
  state.game = null;
  state.selectedIds.clear();
  state.layoffMode = false;
  document.getElementById('end-game-modal').classList.add('hidden');
  hideRoundOverlay();
  if (state.ws) {
    state.ws.onclose = null; // prevent auto-reconnect
    state.ws.close();
    state.ws = null;
  }
  showScreen('splash');
}

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

// ── Music ──────────────────────────────────────────────────────────────────
const music = document.getElementById('bg-music');
const muteBtn = document.getElementById('btn-mute');

// Browsers allow muted autoplay — start muted, then immediately unmute
music.muted = true;
music.play().then(() => {
  music.muted = false;
}).catch(() => {
  // Autoplay still blocked (rare); fall back to first interaction
  music.muted = false;
  document.addEventListener('click', () => music.play().catch(() => {}), { once: true });
});

muteBtn.addEventListener('click', () => {
  music.muted = !music.muted;
  muteBtn.textContent = music.muted ? '🔇' : '🔊';
});

// ── Event bindings ─────────────────────────────────────────────────────────
document.getElementById('btn-start').addEventListener('click', () => {
  showScreen('select');
});

document.querySelectorAll('.btn-player').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    // Guard: server state must have arrived before a choice is allowed
    if (!state.game) {
      showToast('Still connecting — please wait a moment');
      return;
    }
    const playerName = btn.dataset.player;
    state.myName = playerName;
    renderSelect();
    // Send join on the existing connection — no need to reconnect
    send({ type: 'join', player: playerName });
  });
});

document.getElementById('btn-select-reset').addEventListener('click', () => {
  state.myName = null;
  state.game = null;
  state.selectedIds.clear();
  state.layoffMode = false;
  if (state.ws) {
    state.ws.onclose = null; // prevent auto-reconnect
    state.ws.close();
    state.ws = null;
  }
  showScreen('splash');
});

document.getElementById('btn-end-game').addEventListener('click', () => {
  document.getElementById('end-game-modal').classList.remove('hidden');
});

document.getElementById('btn-end-yes').addEventListener('click', () => {
  send({ type: 'end_game' });
  // doEndGame() will be called when the server echoes end_game back to us
  // If the socket is already dead, navigate locally as a fallback
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) doEndGame();
});

document.getElementById('btn-end-no').addEventListener('click', () => {
  document.getElementById('end-game-modal').classList.add('hidden');
});

document.getElementById('btn-cancel-layoff').addEventListener('click', exitLayoffMode);

document.getElementById('btn-new-game').addEventListener('click', () => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    send({ type: 'reset' });
    state.selectedIds.clear();
    state.layoffMode = false;
    return;
  }

  // Fallback if connection is closed
  state.myName = null;
  state.game = null;
  state.selectedIds.clear();
  state.layoffMode = false;
  document.querySelectorAll('.btn-player').forEach(b => b.style.opacity = '1');
  showScreen('select');
});
