# shellcheck shell=bash
# update_session_state — canonical heartbeat helper used by all workers to
# update their Dispatch Board session file as they progress through the
# pipeline. Writes are atomic (tmp + rename) so concurrent readers never see
# a half-written file.
#
# This is the SINGLE SOURCE OF TRUTH for the heartbeat function. It is sourced
# by:
#   - ai-sdlc-plugin/commands/execute.md (Step 1 preamble — before first call site)
#   - ai-sdlc-plugin/scripts/heartbeat.test.mjs (hermetic test)
# so the test exercises the real function body and catches drift (AISDLC-464).
update_session_state() {
  local task_id_lower="$1" step="$2"
  local session_file=".ai-sdlc/dispatch/sessions/${task_id_lower}.session.json"
  [ -f "$session_file" ] || return 0
  node -e "
    const fs = require('fs');
    const f = process.argv[1];
    const step = process.argv[2];
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      s.currentStep = step;
      s.lastHeartbeat = new Date().toISOString();
      if (step === 'done') s.status = 'done';
      else if (s.status === 'starting') s.status = 'in-progress';
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, f);
    } catch (e) { /* non-fatal */ }
  " "$session_file" "$step" 2>/dev/null || true
}
