export type Role = 'Sales' | 'Project Management' | 'Software Development' | 'Hardware Development'
export type Area = 'Sales' | 'Project' | 'Software' | 'Hardware'
export type Priority = 'Critical' | 'High' | 'Medium' | 'Low'
export type WorkType = 'Opportunity' | 'Requirement' | 'Epic' | 'Story' | 'Task' | 'Bug' | 'Decision'
export type WorkStatus = 'Intake' | 'Ready' | 'In Progress' | 'Blocked' | 'Review' | 'Done'
export type DecisionStatus = 'Proposed' | 'Accepted' | 'Rejected'

export interface WorkItem {
  id: string; title: string; type: WorkType; area: Area; status: WorkStatus; owner: Role
  stakeholder: string; priority: Priority; effort: number; businessValue: number; risk: number
  sprint: string; release: string; due: string; dependsOn: string; acceptance: string; updatedAt: string
}
export interface Stakeholder {
  id: string; name: string; role: Role; focus: string; cadence: string; openRequests: number
}
export interface Decision {
  id: string; title: string; owner: Role; impact: Area; status: DecisionStatus; date: string; notes: string
}
export interface AgileState {
  items: WorkItem[]; stakeholders: Stakeholder[]; decisions: Decision[]; activeSprint: string; releaseGoal: string
}
export interface WorkspaceSnapshot {
  state: AgileState
  revision: number
  permissions: { editWork: boolean; approveDecisions: boolean; importWorkspace: boolean }
}
export interface WorkspaceAudit {
  id: string; actorId: string; actorName: string; action: string; revision: number; createdAt: string
}
export type WorkspaceOperation =
  | { type: 'create_item'; item: WorkItem }
  | { type: 'update_item'; id: string; patch: Partial<WorkItem> }
  | { type: 'create_decision'; decision: Decision }
  | { type: 'update_decision'; id: string; status: DecisionStatus }
  | { type: 'import_workspace'; state: AgileState }
export interface WorkspaceCommand { requestId: string; revision: number; operation: WorkspaceOperation }

export function emptyWorkspace(): AgileState {
  return { items: [], stakeholders: [], decisions: [], activeSprint: 'Sprint 1', releaseGoal: '' }
}
