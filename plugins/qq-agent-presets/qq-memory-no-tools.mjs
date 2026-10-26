// 整理只使用桥接提供的文本证据；继承工具即使出现也不能执行。
export const name = 'qq-memory-no-tools';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.guard(() => '记忆整理会话禁止调用工具，只能返回整理 JSON');
}
