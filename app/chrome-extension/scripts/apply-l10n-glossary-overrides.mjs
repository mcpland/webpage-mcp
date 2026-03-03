#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const localesRoot = path.join(root, '_locales');

const overrides = {
  de: {
    agentChatComposerPlaceholder: 'Claude um Code bitten...',
    agentComposerReasoningEffortTooltip: 'Argumentationsaufwand',
    agentComposerSendTitle: 'Senden',
    agentProjectMenuEffortLabel: 'Aufwand',
    agentProjectMenuSaving: 'Speichern...',
    agentSessionEngineLabel: 'Engine',
    agentSessionsSearchPlaceholder: 'Sitzungen suchen...',
    agentSessionViewTools: 'Werkzeuge anzeigen ($ARG1$)',
    agentSessionViewMcpServers: 'MCP-Server anzeigen ($ARG1$)',
    builderAutoLayoutTitle: 'Automatisches Layout',
    builderEdgeTitle: 'Kante',
    builderFitViewTitle: 'Ansicht anpassen',
    builderFlowCategory: 'Flow',
    builderIfConditionLabel: 'Bedingung $ARG1$',
    builderIfElseLabel: 'Sonst',
    builderNewWorkflowName: 'Neuer Workflow',
    builderRunAllTitle: 'Ab Anfang wiedergeben und korrigieren',
    builderRunFromSelectedButton: 'Ab ausgewähltem Knoten ausführen',
    builderRunFromSelectedTitle: 'Wiedergabe ab ausgewähltem Knoten',
    builderSavingStatus: 'Speichern...',
    createRunSectionTitle: 'Erstellen / Ausführen',
    popupQuickToolsTitle: 'Schnellwerkzeuge',
    runAtLabel: 'Ausgeführt um',
    tableHeaderRunAt: 'Ausgeführt um',
    triggerPanelAddOnce: '+ Einmalig',
    triggerPanelDescribeManual: 'Manueller Auslöser (per Schaltfläche auslösen)',
    triggerPanelRunEnqueued: 'Ausführung zur Warteschlange hinzugefügt',
    welcomeCopyButton: 'Kopieren',
    welcomeCurrentExtensionId: 'Aktuelle Erweiterungs-ID:',
    welcomeOpenTroubleshootingDocs: 'Dokumentation zur Fehlerbehebung öffnen',
    welcomeRegisterHostDesc:
      'Führen Sie diesen Befehl zuerst aus. Er schreibt das Native-Messaging-Manifest mit Ihrer aktuellen Erweiterungs-ID, damit Chrome den lokalen Hostprozess starten kann.',
    welcomeTroubleshootingCommands: 'doctor | report',
    welcomeTroubleshootingDocsButton: 'Dokumentation zur Fehlerbehebung',
    workflowsNoRunHistory: 'Noch kein Ausführungsverlauf',
    workflowsRunHistory: 'Ausführungsverlauf',
    workflowsExportAction: 'Exportieren',
    workflowsImportAction: 'Importieren',
    workflowsRunAction: 'Ausführen',
    workflowsRunRunning: 'Wird ausgeführt',
  },
  ja: {
    agentChatComposerPlaceholder: 'Claude にコード作成を依頼...',
    agentComposerReasoningEffortTooltip: '推論強度',
    agentPreviewFooterLabel: 'エージェントプレビュー',
    agentPromptPreviewLabel: 'プロンプトのプレビュー:',
    agentProjectMenuEffortLabel: '推論強度',
    agentProjectMenuSaving: '保存中...',
    agentSessionClaudeCodeLabel: 'Claude Code',
    agentSessionDeleteConfirm: 'このセッションを削除しますか？この操作は元に戻せません。',
    agentSessionDeleteTitle: '削除',
    agentSessionNewShort: '新規',
    agentSessionPermissionBypass: 'bypassPermissions - すべて自動承認',
    agentSessionPermissionDontAsk: 'dontAsk - 確認なし',
    agentSessionReasoningEffortHint:
      '推論の深さを制御します。高いほど品質は向上しますが、時間がかかります。',
    agentSessionReasoningEffortLabel: '推論の強度',
    agentSessionRunningBadge: '実行中',
    agentSessionViewMcpServers: 'MCP サーバーを表示 ($ARG1$)',
    agentSessionViewTools: 'ツールを表示 ($ARG1$)',
    builderAutoLayoutTitle: '自動レイアウト',
    builderEdgeTitle: 'エッジ',
    builderFitViewTitle: '表示を全体に合わせる',
    builderFlowCategory: 'フロー',
    builderIfConditionLabel: '条件 $ARG1$',
    builderIfElseLabel: 'それ以外',
    builderNewWorkflowName: '新規ワークフロー',
    builderRunFromSelectedButton: '選択したノードから実行',
    builderSavingStatus: '保存中...',
    deleteButton: '削除',
    popupIntelligentAssistantTitle: 'AIアシスタント',
    popupOneTimeHostRegistrationLabel: 'ワンタイムホスト登録（現在の拡張機能 ID）',
    runAtLabel: '実行時刻',
    sidepanelMarkerActionDelete: '削除',
    tableHeaderRunAt: '実行時刻',
    triggerPanelCreate: '作成',
    triggerPanelDescribeManual: '手動トリガー（ボタンで実行）',
    triggerPanelRunEnqueued: '実行をキューに追加しました',
    downloadingModelStatus: 'モデルをダウンロード中... $PROGRESS$%',
    serviceRunningStatus: 'サービス実行中 (ポート: $PORT$)',
    welcomeOpenTroubleshootingDocs: 'トラブルシューティングドキュメントを開く',
    welcomeRegisterHostDesc:
      'まずこのコマンドを実行してください。現在の拡張機能 ID で Native Messaging マニフェストを書き込み、Chrome がローカルホストプロセスを起動できるようにします。',
    welcomeTroubleshootingCommands: 'doctor | report',
    welcomeTroubleshootingDocsButton: 'トラブルシューティングドキュメント',
    workflowsDeleteAction: '削除',
    workflowsDeleteTriggerTitle: '削除',
    workflowsExportAction: 'エクスポート',
    workflowsImportAction: 'インポート',
    workflowsRunAction: '実行',
    workflowsRunFailed: '失敗',
    workflowsRunRunning: '実行中',
    workflowsRunSucceeded: '成功',
    workflowsRunWorkflowTitle: 'ワークフローを実行',
  },
  ko: {
    agentComposerReasoningEffortTooltip: '추론 강도',
    agentComposerSendTitle: '보내기',
    agentProjectMenuEffortLabel: '추론 강도',
    agentProjectMenuSaving: '저장 중...',
    agentSessionCreating: '생성 중...',
    agentSessionNewShort: '신규',
    agentSessionPermissionBypass: 'bypassPermissions - 모두 자동 승인',
    agentSessionReasoningEffortLabel: '추론 강도',
    agentSessionRunningBadge: '실행 중',
    agentSessionViewMcpServers: 'MCP 서버 보기 ($ARG1$)',
    agentSessionViewTools: '도구 보기 ($ARG1$)',
    builderAutoLayoutTitle: '자동 레이아웃',
    builderEdgeTitle: '엣지',
    builderFlowCategory: '플로우',
    builderIfElseLabel: '그 외',
    builderNewWorkflowName: '새 워크플로',
    builderSavingStatus: '저장 중...',
    runAtLabel: '실행 시각',
    tableHeaderRunAt: '실행 시각',
    builderVisualOrchestrationTip: '워크플로 시각적 오케스트레이션',
    popupIntelligentAssistantTitle: 'AI 어시스턴트',
    popupOneTimeHostRegistrationLabel: '일회성 호스트 등록(현재 확장 프로그램 ID)',
    triggerPanelCreate: '생성',
    triggerPanelDescribeManual: '수동 트리거(버튼으로 실행)',
    triggerPanelRunEnqueued: '실행이 대기열에 추가됨',
    welcomeOpenTroubleshootingDocs: '문제 해결 문서 열기',
    welcomeRegisterHostDesc:
      '먼저 이 명령을 실행하세요. 현재 확장 ID로 Native Messaging 매니페스트를 작성하여 Chrome이 로컬 호스트 프로세스를 시작할 수 있게 합니다.',
    welcomeTroubleshootingCommands: 'doctor | report',
    welcomeTroubleshootingDocsButton: '문제 해결 문서',
    workflowsExportAction: '내보내기',
    workflowsImportAction: '가져오기',
    workflowsRunAction: '실행',
    workflowsRunFailed: '실패',
    workflowsRunRunning: '실행 중',
    workflowsRunSucceeded: '성공',
    workflowsRunWorkflowTitle: '워크플로 실행',
  },
  zh_CN: {
    agentComposerReasoningEffortTooltip: '推理强度',
    agentProjectMenuEffortHint: '适用于新会话。已有会话请在“会话设置”中编辑。',
    agentProjectMenuEffortLabel: '推理强度',
    agentProjectMenuSaving: '保存中...',
    agentSessionReasoningEffortHint: '控制推理深度。强度越高，质量越好，但速度越慢。',
    agentSessionReasoningEffortLabel: '推理强度',
    builderAutoLayoutTitle: '自动布局',
    builderEdgeTitle: '连线',
    builderFlowCategory: '流程',
    builderIfConditionLabel: '条件 $ARG1$',
    builderIfElseLabel: '否则',
    builderNewWorkflowName: '新建工作流',
    builderSavingStatus: '保存中...',
    popupOneTimeHostRegistrationLabel: '一次性主机注册（当前扩展程序 ID）',
    welcomeCurrentExtensionId: '当前扩展程序 ID：',
    welcomeTroubleshootingCommands: 'doctor | report',
  },
  zh_TW: {
    agentChatComposerPlaceholder: '請 Claude 幫我寫程式...',
    agentComposerReasoningEffortTooltip: '推理強度',
    agentPreviewFooterLabel: 'Agent 預覽',
    agentComposerResetConfirm: '要重設此對話嗎？所有訊息都會被刪除，工作階段將重新開始。',
    agentComposerSessionSettingsTooltip: '工作階段設定',
    agentProjectMenuEffortHint: '適用於新工作階段。既有工作階段請在「工作階段設定」中調整。',
    agentProjectMenuEffortLabel: '推理強度',
    agentProjectMenuSaving: '儲存中...',
    agentSessionActiveModelLabel: '目前模型',
    agentSessionClaudeCodeLabel: 'Claude Code',
    agentSessionCreating: '建立中...',
    agentSessionDeleteConfirm: '刪除此工作階段？此操作無法復原。',
    agentSessionDeleteNamedConfirm: '刪除「$ARG1$」？',
    agentSessionEngineSessionLabel: '引擎工作階段',
    agentSessionInfoSection: '工作階段資訊',
    agentSessionNewButton: '+ 新工作階段',
    agentSessionNewShort: '新增',
    agentSessionOpenProjectTitle: '開啟專案',
    agentSessionPermissionBypass: 'bypassPermissions - 自動批准所有操作',
    agentSessionPermissionDontAsk: 'dontAsk - 不需確認',
    agentSessionReasoningEffortHint: '控制推理深度。強度越高，品質越好，但速度越慢。',
    agentSessionReasoningEffortLabel: '推理強度',
    agentSessionRunningBadge: '執行中',
    agentSessionSdkInfoLabel: 'SDK 資訊',
    agentSessionSettingsLoading: '正在載入工作階段資訊...',
    agentSessionSettingsTitle: '工作階段設定',
    agentSessionThisSession: '目前工作階段',
    agentSessionViewMcpServers: '檢視 MCP 伺服器 ($ARG1$)',
    agentSessionViewTools: '檢視工具 ($ARG1$)',
    agentSessionsEmpty: '尚無工作階段',
    agentSessionsLoading: '正在載入工作階段...',
    agentSessionsNoMatching: '沒有符合的工作階段',
    agentSessionsSearchPlaceholder: '搜尋工作階段...',
    agentSessionsStartNewButton: '開始新工作階段',
    agentSessionsTitle: '工作階段',
    agentSessionsUnnamed: '未命名工作階段',
    agentTopBarBackToSessionsTitle: '返回工作階段',
    builderConfigurationErrorTitle: '⚠️ 設定錯誤',
    builderConfigurationTitle: '設定',
    builderAutoLayoutTitle: '自動佈局',
    builderEdgeTitle: '連線',
    builderFitViewTitle: '自動調整視圖',
    builderFlowCategory: '流程',
    builderGeneralSettingsTitle: '一般設定',
    builderIfConditionLabel: '條件 $ARG1$',
    builderIfElseLabel: '否則',
    builderNewWorkflowName: '新工作流程',
    builderRunAllTitle: '從頭開始執行',
    builderRunFromSelectedButton: '從所選節點執行',
    builderRunFromSelectedTitle: '從選取節點執行',
    builderSavingStatus: '儲存中...',
    createRunSectionTitle: '建立 / 執行',
    popupElementMarkerManagementTitle: '元素標註管理',
    popupOneTimeHostRegistrationLabel: '一次性主機註冊（目前擴充功能 ID）',
    runAtLabel: '執行時間',
    tableHeaderRunAt: '執行時間',
    triggerPanelCreate: '建立',
    triggerPanelOtherTypesHint: '其他類型（url/cron/command/contextMenu/dom）請透過觸發節點設定。',
    triggerPanelRunEnqueued: '已加入執行佇列',
    welcomeDiagnosticsDesc: '執行「doctor」以檢查安裝狀態。若回報錯誤，請執行自動修復命令。',
    welcomeCurrentExtensionId: '目前擴充功能 ID：',
    welcomeRegisterHostDesc:
      '請先執行此命令。它會使用目前擴充功能 ID 寫入 Native Messaging 資訊清單，讓 Chrome 可啟動本機主機程序。',
    welcomeOpenTroubleshootingDocs: '開啟疑難排解文件',
    welcomeTroubleshootingCommands: 'doctor | report',
    welcomeTroubleshootingDocsButton: '疑難排解文件',
    workflowsExportAction: '匯出',
    workflowsImportAction: '匯入',
    workflowsNoTriggers: '尚未設定觸發器',
    workflowsNoRunHistory: '尚無執行歷史記錄',
    workflowsRunAction: '執行',
    workflowsRunCanceled: '已取消',
    workflowsRunFailed: '失敗',
    workflowsRunHistory: '執行歷史',
    workflowsRunQueued: '排隊中',
    workflowsRunRunning: '執行中',
    workflowsRunStatusPrefix: '狀態',
    workflowsRunSucceeded: '成功',
    workflowsRunWorkflowTitle: '執行工作流程',
  },
};

let totalUpdated = 0;

for (const [locale, map] of Object.entries(overrides)) {
  const localePath = path.join(localesRoot, locale, 'messages.json');
  if (!fs.existsSync(localePath)) {
    continue;
  }

  const data = JSON.parse(fs.readFileSync(localePath, 'utf8'));
  let changed = 0;

  for (const [key, message] of Object.entries(map)) {
    if (!data[key]) {
      continue;
    }
    if (data[key].message !== message) {
      data[key].message = message;
      changed += 1;
    }
  }

  if (changed > 0) {
    const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(localePath, `${JSON.stringify(sorted, null, 2)}\n`);
  }

  totalUpdated += changed;
  console.log(`${locale}: updated ${changed}`);
}

console.log(`Total updated: ${totalUpdated}`);
