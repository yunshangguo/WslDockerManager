// Connection-resilient wrapper for dockerode-backed calls.
//
// If a docker request fails because the daemon isn't reachable right now
// (ECONNREFUSED on 127.0.0.1:2375, ETIMEDOUT, ECONNRESET, …), first ride out
// a few gentle retries with backoff — a momentary WSL localhost forwarding blip
// usually clears within 1–2s on its own, so we never touch dockerd (and never
// kill a container) for those. Only if all gentle retries fail do we force
// dockerd up via ensureDockerd(true) and try once more.
// Non-connection errors are surfaced immediately.
//
// This is what makes "connect ECONNREFUSED 127.0.0.1:2375" disappear for the
// momentary gaps (sleep/resume, a ~2s dockerd auto-restart, a transient
// forward drop) instead of erroring the user's request. Containers.js used to
// define this locally; it is now shared so every read route self-heals the same
// way (the background-task path already had equivalent recovery in tasks.js).
const { ensureDockerd } = require('./wsl');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function withDockerd(fn) {
  const CONN_ERR = /ECONNREFUSED|refused|socket hang up|daemon|connect.*2375|ETIMEDOUT|ECONNRESET|network is unreachable/i;
  let lastErr;
  // 1) Gentle retries: wait out transient blips cheaply.
  for (let i = 0; i < 3; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = (e && e.message) || '';
      if (!CONN_ERR.test(msg)) throw e; // non-connection error -> not retriable
      lastErr = e;
      await sleep(700 * (i + 1)); // 0.7s / 1.4s / 2.1s
    }
  }
  // 2) Genuine outage: force dockerd up (Restart=always means a real crash is
  //    already auto-recovering; ensureDockerd only acts when nothing is bound),
  //    then one final attempt.
  await ensureDockerd(true).catch(() => {});
  try { return await fn(); }
  catch (e) { throw lastErr; }
}

module.exports = { withDockerd };
