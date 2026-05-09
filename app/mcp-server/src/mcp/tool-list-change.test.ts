import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import {
  shouldNotifyWorkflowToolListChanged,
  shouldRefreshWorkflowToolList,
} from './tool-list-change';

describe('workflow tool-list change notifications', () => {
  it('marks workflow descriptor mutations as tool-list refreshes', () => {
    expect(shouldRefreshWorkflowToolList(TOOL_NAMES.RECORD_REPLAY.FLOW_UPDATE, {})).toBe(true);
    expect(shouldRefreshWorkflowToolList(TOOL_NAMES.RECORD_REPLAY.WORKFLOW_REPAIR, {})).toBe(true);
    expect(shouldRefreshWorkflowToolList(TOOL_NAMES.RECORD_REPLAY.WORKFLOW_REPAIR_ROLLBACK, {})).toBe(
      true,
    );
    expect(shouldRefreshWorkflowToolList(TOOL_NAMES.RECORD_REPLAY.WORKFLOW_PUBLISH, {})).toBe(true);
    expect(shouldRefreshWorkflowToolList(TOOL_NAMES.RECORD_REPLAY.WORKFLOW_UNPUBLISH, {})).toBe(true);
  });

  it('only marks workflow_stabilize when apply writes changes', () => {
    expect(
      shouldRefreshWorkflowToolList(TOOL_NAMES.RECORD_REPLAY.WORKFLOW_STABILIZE, {
        apply: true,
      }),
    ).toBe(true);
    expect(
      shouldRefreshWorkflowToolList(TOOL_NAMES.RECORD_REPLAY.WORKFLOW_STABILIZE, {
        apply: false,
      }),
    ).toBe(false);
    expect(shouldRefreshWorkflowToolList(TOOL_NAMES.RECORD_REPLAY.WORKFLOW_STABILIZE, undefined)).toBe(
      false,
    );
  });

  it('marks workflow_migrate only for mutating apply or rollback calls', () => {
    expect(
      shouldRefreshWorkflowToolList(TOOL_NAMES.RECORD_REPLAY.WORKFLOW_MIGRATE, {
        apply: true,
        dryRun: false,
      }),
    ).toBe(true);
    expect(
      shouldRefreshWorkflowToolList(TOOL_NAMES.RECORD_REPLAY.WORKFLOW_MIGRATE, {
        rollbackMigrationId: 'migration-1',
        dryRun: false,
      }),
    ).toBe(true);
    expect(
      shouldRefreshWorkflowToolList(TOOL_NAMES.RECORD_REPLAY.WORKFLOW_MIGRATE, {
        apply: true,
        dryRun: true,
      }),
    ).toBe(false);
    expect(
      shouldRefreshWorkflowToolList(TOOL_NAMES.RECORD_REPLAY.WORKFLOW_MIGRATE, {
        rollbackMigrationId: 'migration-1',
      }),
    ).toBe(false);
  });

  it('only notifies after a successful tool result', () => {
    expect(
      shouldNotifyWorkflowToolListChanged(
        TOOL_NAMES.RECORD_REPLAY.WORKFLOW_PUBLISH,
        {},
        { content: [{ type: 'text', text: '{"success":true}' }], isError: false },
      ),
    ).toBe(true);
    expect(
      shouldNotifyWorkflowToolListChanged(
        TOOL_NAMES.RECORD_REPLAY.WORKFLOW_PUBLISH,
        {},
        { content: [{ type: 'text', text: '{"success":false}' }], isError: true },
      ),
    ).toBe(false);
    expect(
      shouldNotifyWorkflowToolListChanged(
        TOOL_NAMES.RECORD_REPLAY.FLOW_RUN,
        {},
        { content: [{ type: 'text', text: '{"success":true}' }], isError: false },
      ),
    ).toBe(false);
  });
});
