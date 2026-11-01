// Protocol fixture: it never calls a model, reads credentials, or executes a task.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli test-fixture'); process.exit(0); }
if (args.includes('--help')) { console.log('--json --sandbox --output-last-message --color'); process.exit(0); }
let input = '';
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: 'thread.started', thread_id: 'fixture-thread-id' });
if (config.scenario === 'hang') { setInterval(() => {}, 1000); }
else if (config.scenario === 'failure') { process.stderr.write('fixture failure\n'); emit({ type: 'turn.failed', error: { message: 'fixture failed turn' } }); process.exitCode = 7; }
else if (config.scenario === 'malformed') { console.log('{bad JSON'); emit({ type: 'turn.completed' }); }
else if (config.scenario === 'flood') { process.stdout.write('x'.repeat(256 * 1024)); setInterval(() => {}, 1000); }
else if (config.scenario === 'incomplete') { emit({ type: 'item.completed', item: { type: 'agent_message', text: 'no completed turn' } }); }
else {
  const text = JSON.stringify({ prompt: config.message ?? '', args, cwd: process.cwd() });
  if (config.scenario !== 'event-only') fs.writeFileSync(args[args.indexOf('-o') + 1], config.scenario === 'huge-final' ? 'x'.repeat(256 * 1024) : text);
  emit({ type: 'item.completed', item: { type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 22 } });
}
