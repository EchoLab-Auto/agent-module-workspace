//! 工作区表单里的 **JSON 段**：粘贴一段落盘 JSON → 解析 → 回填表单或批量提交。
//!
//! ## 为什么要有
//!
//! 表单只有名称 / 描述 / 目录三个字段，而一份工作区真正落盘的字段还包含
//! `conversations`（每个对话的 id / legacy / api_profile）与 `last_conversation`。
//! 迁移机器、复制既有项目、批量建多个工作区时，用户手上往往正好是一段
//! `echo-workspaces-<team>.json` 的原文——表单填不了，只能手工重复。
//!
//! 解析本身在 `workspace-json.ts`（纯函数，无 Vue）。**本模块负责状态**：
//! 文本框内容、脏判定、错误/提示、以及「解析结果如何回填表单三字段」。
//!
//! ## 为什么从 `WorkspacePanel.vue` 里拿出来
//!
//! 这套状态原先散在面板组件的 155 行里（夹在新建表单与对话管理之间），
//! 但它与面板的其余职责没有交集，只有一个交界：**解析成功后写表单三字段**。
//! 把交界显式化成入参（`formName` / `formDescription` / `formDirs`），
//! 规则就能脱离组件单独验证，组件也只留「调用 → 派发命令」。
//!
//! ## 一条必须遵守的约定
//!
//! **保存前自动应用未应用的改动**（`dirty` 为真时先调 `apply()`）。否则
//! 「贴了 JSON 直接点保存」会静默丢掉 JSON 里的内容——这是这条路径最容易
//! 踩的坑，也是 `save` 里那段 `if (dirty) apply()` 的由来。

import { computed, ref, type Ref } from 'vue';
import type {
  WorkspaceConversationInfo,
  WorkspaceDirectoryEntry,
  WorkspaceSessionInfo,
} from '@echo-agent/panel';
import { parseWorkspaceJson, sessionToJson } from './workspace-json';

export interface UseSessionJsonFormOptions {
  /** 正在编辑的会话 id；`''` = 新建（新建允许批量导入 1..N 份）。 */
  editingId: () => string;
  /** 表单三字段——解析成功后由本模块回填。 */
  formName: Ref<string>;
  formDescription: Ref<string>;
  formDirs: Ref<string>;
  /** 按 id 查既有会话（「重置」重新生成文本时用）。 */
  findSession: (id: string) => WorkspaceSessionInfo | undefined;
  /** 目录编辑串的规范化（跨机目录对象 → `node://` 串）；由调用方注入以免重复实现。 */
  toInput: (dir: WorkspaceDirectoryEntry) => string;
}

export function useSessionJsonForm(options: UseSessionJsonFormOptions) {
  const { editingId, formName, formDescription, formDirs, findSession, toInput } = options;

  /** 文本框内容。 */
  const text = ref('');
  /** 上次生成 / 应用时的文本：与它不同 = 用户改过还没应用。 */
  const baseline = ref('');
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  /**
   * 应用 JSON 后携带的对话；`null` = 本次不动既有对话。
   *
   * 必须与「表单保存」的语义区分开：`SaveWorkspaceSession` 是**全量替换**，
   * 空数组在 Core 侧同样解释为「未提供」——所以只有 JSON 明确给了
   * `conversations` 才替换，否则沿用既有会话的。
   */
  const conversations = ref<WorkspaceConversationInfo[] | null>(null);
  const lastConversation = ref<string | null>(null);

  const dirty = computed(() => text.value.trim() !== '' && text.value !== baseline.value);

  function resetFeedback(): void {
    error.value = null;
    notice.value = null;
  }

  /** 清空（新建 / 取消编辑）：文本、基线、携带值、反馈一起归零。 */
  function clear(): void {
    text.value = '';
    baseline.value = '';
    conversations.value = null;
    lastConversation.value = null;
    resetFeedback();
  }

  /** 以既有会话为初值（进入编辑态）。 */
  function seed(session: WorkspaceSessionInfo): void {
    conversations.value = null;
    lastConversation.value = null;
    text.value = sessionToJson(session);
    baseline.value = text.value;
    resetFeedback();
  }

  /** 重新生成文本，丢弃用户改动（「重置」按钮）。 */
  function reset(): void {
    const id = editingId();
    const existing = id ? findSession(id) : undefined;
    text.value = existing ? sessionToJson(existing) : '';
    baseline.value = text.value;
    conversations.value = null;
    lastConversation.value = null;
    resetFeedback();
  }

  /**
   * 解析当前文本并回填表单。返回可提交的会话数组（失败 → `null`，原因已写进 `error`）。
   *
   * 新建：允许 1..N 份（N>1 = 批量导入，调用方逐条发命令）。
   * 编辑：只允许 1 份，且 id 必须与正在编辑的一致——改 id 等于「另建一份」，
   * 会留下一条指向旧 id 的孤儿记录。
   */
  function apply(): WorkspaceSessionInfo[] | null {
    resetFeedback();
    const parsed = parseWorkspaceJson(text.value);
    if (!parsed.ok) {
      error.value = parsed.error;
      return null;
    }
    const id = editingId();
    /** 把解析结果写进表单（两种模式共用的那一段）。 */
    const fill = (session: WorkspaceSessionInfo): void => {
      formName.value = session.name;
      formDescription.value = session.description ?? '';
      formDirs.value = (session.directories ?? []).map(toInput).join('\n');
      conversations.value = session.conversations ?? null;
      lastConversation.value = session.last_conversation ?? null;
    };

    if (id) {
      if (parsed.sessions.length !== 1) {
        error.value = `编辑时只能有一份工作区（当前 ${parsed.sessions.length} 份）`;
        return null;
      }
      const raw = parsed.sessions[0];
      if (raw.id && raw.id !== id) {
        error.value = `编辑时不能修改工作区 id（当前「${id}」，JSON 里是「${raw.id}」）`;
        return null;
      }
      const only: WorkspaceSessionInfo = { ...raw, id };
      fill(only);
      baseline.value = text.value;
      notice.value =
        parsed.document && parsed.active
          ? `已应用 JSON（文档里的 active「${parsed.active}」不随保存写入，激活请在列表里点）`
          : '已应用 JSON（点「保存」生效）';
      return [only];
    }

    // 新建：只回填第一份，让用户看到即将创建什么。
    fill(parsed.sessions[0]);
    baseline.value = text.value;
    notice.value =
      parsed.sessions.length > 1
        ? `已解析 ${parsed.sessions.length} 份工作区，保存后批量导入`
        : '已解析 1 份工作区（点「保存」创建）';
    return parsed.sessions;
  }

  return {
    text,
    error,
    notice,
    dirty,
    conversations,
    lastConversation,
    resetFeedback,
    clear,
    seed,
    reset,
    apply,
  };
}
