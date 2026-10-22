// Command outcomes, kept distinct so the UI never collapses "the projector was busy"
// into "the projector can't do that" (same rule as Projector Control).
const OUTCOMES = {
  ok: 'answered or confirmed',
  accepted: 'acknowledged by the device; state not yet confirmed',
  sent: 'sent; this protocol gives no acknowledgement',
  busy: 'device busy or in a state where it refuses this; try again',
  rejected: 'device refused the value',
  unsupported: 'device says it does not have this command',
  not_sent: 'not sent by this app (unverified command, or not valid for this model)',
  timeout: 'no reply; the command may or may not have happened',
  auth_failed: 'password refused',
  fault: 'device reported a fault',
  offline: 'could not connect; nothing was sent',
};

function result(outcome, detail = '', extra = {}) {
  return { outcome, detail, ...extra };
}
const isGood = r => !r || ['ok', 'accepted', 'sent'].includes(r.outcome);

module.exports = { OUTCOMES, result, isGood };
