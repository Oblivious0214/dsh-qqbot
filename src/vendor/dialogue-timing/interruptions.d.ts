export function chatActivity(snapshot: unknown): string;
export function submissionActivity(snapshot: unknown): string;
export class Interruptions {
  observe(id: string, chat: string, submissions: string): boolean;
  blocked(id: string, reply: { turn?: number; step?: number } | undefined): boolean;
}
