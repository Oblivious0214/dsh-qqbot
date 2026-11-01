import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
type TurnReader = Partial<Pick<Context['agents'], 'turnBoundaryOf'>>;
type TurnSession = Agent['session'];
/** 新宿主使用轮次投影；缺少该接口的宿主从保留的完整事件快照读取同一轮次。 */
export declare function lastTurnOf(agents: TurnReader, session: TurnSession): number;
export {};
