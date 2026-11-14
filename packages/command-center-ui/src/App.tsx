import { Activity, CreditCard, FileText, LineChart, Radio } from 'lucide-react';
import { ActStepper } from './components/ActStepper';
import { ActionPanel, NarrativeBlock } from './components/ActionPanel';
import { CashflowChart } from './components/CashflowChart';
import { ContractPanel } from './components/ContractPanel';
import { LiveTelemetryConsole } from './components/LiveTelemetryConsole';
import { VirtualCardWidget } from './components/VirtualCardWidget';
import { VisaTapPassport } from './components/VisaTapPassport';
import { useRun } from './useRun';

export default function App() {
  const { state, events, connected, call, runFullDemo, demoRunning } = useRun();
  const g = state?.guardrails;

  return (
    <div className="flex min-h-full flex-col lg:h-full">
      <ActStepper state={state} connected={connected} demoRunning={demoRunning} onRunDemo={() => runFullDemo()} onReset={() => call('reset').catch(() => undefined)} />

      <main className="grid flex-1 grid-cols-1 content-start gap-3 p-3 lg:min-h-0 lg:content-stretch lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)] lg:overflow-hidden">
        {/* LEFT: contract + treasury */}
        <section className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pr-1 scrollbar-thin">
          <div className="panel">
            <div className="panel-title">
              <LineChart className="h-3.5 w-3.5" /> 8-week treasury projection
              {g && <span className="ml-auto font-mono normal-case tracking-normal text-ink-400">opening ${g.openingBalance.toLocaleString()} · floor ${g.reserveFloor.toLocaleString()}</span>}
            </div>
            <CashflowChart state={state} />
            {state?.plan && (
              <div className="px-3 pb-3">
                <NarrativeBlock title="Why monthly" n={state.plan.narrative} />
              </div>
            )}
          </div>
          <div className="panel">
            <div className="panel-title"><FileText className="h-3.5 w-3.5" /> Vendor order form · CloudScale Inc</div>
            <ContractPanel state={state} />
          </div>
        </section>

        {/* CENTER: card + actions + TAP */}
        <section className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pr-1 scrollbar-thin">
          <div className="panel">
            <div className="panel-title"><Activity className="h-3.5 w-3.5" /> Agent control</div>
            <ActionPanel state={state} call={call} disabled={demoRunning} />
          </div>
          <div className="panel">
            <div className="panel-title"><CreditCard className="h-3.5 w-3.5" /> Airwallex Visa virtual card</div>
            <VirtualCardWidget state={state} />
          </div>
          <div className="panel">
            <div className="panel-title"><Radio className="h-3.5 w-3.5" /> Visa TAP agent passport</div>
            <VisaTapPassport state={state} onProbe={() => call('probe/unsigned-bot').catch(() => undefined)} />
          </div>
        </section>

        {/* RIGHT: telemetry */}
        <section className="panel flex min-h-[420px] flex-col lg:min-h-0">
          <div className="panel-title">
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-status-good' : 'bg-status-critical'}`} /> Live API & protocol telemetry
            <span className="ml-auto font-mono normal-case tracking-normal text-ink-500">{state?.rail.mode === 'LIVE' ? 'api.sandbox.airwallex.com' : state?.rail.mode === 'EMULATOR' ? 'offline emulator' : ''}</span>
          </div>
          <LiveTelemetryConsole events={events} />
        </section>
      </main>
    </div>
  );
}
