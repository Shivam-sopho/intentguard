import { useEffect, useRef, useState } from 'react';
import { ActStepper } from './components/ActStepper';
import { BlockedScreen, CardScreen, PaidScreen, PlanScreen, RulesScreen, useScrollTop, type ScreenProps } from './components/screens';
import { TechDrawer } from './components/TechDrawer';
import { useRun } from './useRun';

/** Which step screen an in-flight action belongs to. */
function screenForBusy(label: string | null | undefined): number | null {
  if (!label) return null;
  if (label.includes('Act 5')) return 4; // resolving is shown on the "stop the overcharge" screen
  if (label.includes('shock')) return 3; // checkout starts from the card screen
  if (label.includes('approval')) return 3;
  if (label.includes('Act 2')) return 2;
  if (label.includes('Act 1')) return 1;
  return null;
}

export default function App() {
  const { state, events, call, runFullDemo, demoRunning } = useRun();
  const [view, setView] = useState(1);
  const [drawer, setDrawer] = useState(false);
  const [busySince, setBusySince] = useState<string | null>(null);
  const lastAct = useRef(0);

  // Follow the run: when an act completes, show the screen with its results. Wait until the
  // action has fully finished (busy cleared) so a half-built result screen never flashes.
  useEffect(() => {
    if (!state || state.busy) return;
    if (state.act !== lastAct.current) {
      lastAct.current = state.act;
      setView(Math.max(1, state.act));
    }
  }, [state?.act, state?.busy]);

  // While an action runs, show its screen with the live activity feed. If it fails,
  // return to the screen whose button started it, where the error is shown.
  const busyScreen = screenForBusy(state?.busy);
  const prevBusy = useRef<number | null>(null);
  useEffect(() => {
    if (busyScreen) {
      setView(busyScreen);
      setBusySince(new Date(Date.now() - 1000).toISOString());
    } else if (prevBusy.current && state?.error) {
      setView(Math.max(1, state.act));
    }
    prevBusy.current = busyScreen;
  }, [busyScreen]);

  useScrollTop(view);

  if (!state) {
    return <div className="grid min-h-full place-items-center text-ink-400">Connecting to IntentGuard…</div>;
  }

  const props: ScreenProps = {
    state,
    call,
    busy: Boolean(state.busy) || demoRunning,
    working: busyScreen === view,
    events,
    busySince,
    goTo: setView,
    openDrawer: () => setDrawer(true),
  };

  return (
    <div className="min-h-full">
      <ActStepper
        state={state}
        view={view}
        onView={setView}
        onRunDemo={() => runFullDemo()}
        onReset={() => call('reset').catch(() => undefined)}
        onOpenDrawer={() => setDrawer(true)}
        eventCount={events.length}
        demoRunning={demoRunning}
      />
      <main>
        {view === 1 && <RulesScreen {...props} />}
        {view === 2 && <PlanScreen {...props} />}
        {view === 3 && <CardScreen {...props} />}
        {view === 4 && <BlockedScreen {...props} />}
        {view === 5 && <PaidScreen {...props} />}
      </main>
      <TechDrawer open={drawer} onClose={() => setDrawer(false)} state={state} events={events} onProbe={() => call('probe/unsigned-bot').catch(() => undefined)} />
    </div>
  );
}
