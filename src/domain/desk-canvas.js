/**
 * Desk spec canvas domain model: pure data, no I/O.
 *
 * Migrated verbatim from the retired `src/domain/retrospective.js` (Task 4.2,
 * spec §15 ②): the 4-part spec canvas template is draft-canvas territory, not
 * distillation write-back, so it keeps its own module.
 */

/**
 * Standard SPEC template for brainstorming and spec canvas.
 * @type {string}
 */
export const SPEC_CANVAS_TEMPLATE = `## 1. 目标 (Goal)
- 明确本轮需求的核心目标与预期交付物。

## 2. 架构设计 (Architecture & Design)
- 关键模块划分与交互流程。
- 数据流转与接口契约设计。

## 3. 安全边界与硬约束 (Safety & Constraints)
- 白名单校验与权限边界。
- 幂等性保障、并发冲突防御与回滚策略。

## 4. 任务拆解 (Task Breakdown)
- [ ] Task 1: 
- [ ] Task 2: 
- [ ] Task 3: 
`
