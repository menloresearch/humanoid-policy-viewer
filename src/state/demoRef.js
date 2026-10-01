// A live reference to the current MuJoCoDemo instance, for the rare piece of
// UI (the push-event target-body picker) that lives outside Demo.vue's own
// component tree and needs to borrow its renderer/scene directly. Not
// reactive on purpose — consumers read demoRef.current imperatively when they
// need it (e.g. when a dialog opens), not as a live-bound render dependency.
export const demoRef = { current: null };
