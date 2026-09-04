import { Command } from 'commander'

export function buildCli(version: string): Command {
  const program = new Command()
  program
    .name('agentqa')
    .description('Drive and inspect Android apps from the command line')
    .version(version)
    .option('--json', 'emit machine-readable JSON')
  return program
}
