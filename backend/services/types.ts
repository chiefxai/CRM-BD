export interface FinancialInfo {
  monthlyIncome: number;
  creditScore: number;
  employer: string;
  debtToIncome: number;
}

export interface Lead {
  id: string;
  name: string;
  phone: string;
  email: string;
  amountRequested: number;
  score: number; // AI score 0-100
  source: string; // e.g., Website, Facebook, Direct, Partner
  status: 'New' | 'In Progress' | 'Qualified' | 'Unqualified' | 'Converted';
  tags: string[];
  createdAt: string;
  notes: string;
  financialInfo?: FinancialInfo;
}

export type CampaignStatus = 'Draft' | 'Running' | 'Paused' | 'Completed';

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  workflowId: string;
  totalLeads: number;
  calledLeads: number;
  successfulCalls: number;
  createdAt: string;
}

export type NodeType = 'trigger' | 'call' | 'question' | 'decision' | 'action';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  config: {
    triggerType?: 'new_lead' | 'manual' | 'api';
    prompt?: string;
    questionText?: string;
    branches?: { condition: string; targetId: string }[];
    actionType?: 'assign_agent' | 'schedule_callback' | 'close_lead' | 'send_sms' | 'tag_lead';
    agentId?: string;
    tagName?: string;
  };
  position: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  active: boolean;
  createdAt: string;
}

export interface CallLog {
  id: string;
  leadId: string;
  leadName: string;
  campaignId?: string;
  duration: number; // in seconds
  status: 'Completed' | 'Failed' | 'Busy' | 'In Progress';
  sentiment: 'Positive' | 'Neutral' | 'Negative' | 'Unknown';
  intent: 'Interested' | 'Not Interested' | 'Callback Scheduled' | 'Wrong Number' | 'Unknown';
  transcript: { speaker: 'AI' | 'Customer'; text: string; timestamp: string }[];
  summary: string;
  recordingUrl?: string;
  createdAt: string;
}

export interface LoanDocument {
  id: string;
  name: string;
  type: 'ID Proof' | 'Paystub' | 'Bank Statement' | 'Tax Return';
  status: 'Uploaded' | 'OCR Processing' | 'Verified' | 'Rejected';
  fileSize?: string;
  ocrData?: {
    extractedName?: string;
    extractedIncome?: number;
    extractedEmployer?: string;
    confidenceScore?: number;
    issues?: string[];
  };
}

export interface Loan {
  id: string;
  leadId: string;
  leadName: string;
  amount: number;
  interestRate: number; // e.g., 8.5 for 8.5%
  termMonths: number;
  status: 'Lead' | 'Application' | 'Verification' | 'Approval' | 'Disbursement' | 'Repayment' | 'Completed';
  monthlyEmi: number;
  paidEmiCount: number;
  totalEmiCount: number;
  nextPaymentDate: string;
  documents: LoanDocument[];
  history: {
    status: string;
    updatedAt: string;
    note: string;
    updatedBy: string;
  }[];
}

export interface VirtualNumber {
  id: string;
  number: string;
  provider: 'Twilio' | 'Telnyx' | 'Plivo' | 'SIP Trunk';
  status: 'Active' | 'Inactive';
  friendlyName: string;
  routingUrl: string;
  incomingCallCount: number;
  outgoingCallCount: number;
}

export type UserRole =
  | 'Super Admin'
  | 'Organization Admin'
  | 'Sales Manager'
  | 'Loan Agent'
  | 'Collection Agent'
  | 'AI Agent Manager'
  | 'Customer';

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: 'Active' | 'Inactive';
  performanceScore: number; // 0-100 rating
  assignedLeadsCount: number;
}

export interface OrganizationSettings {
  id: string;
  name: string;
  workspaceName: string;
  subscriptionPlan: 'Starter' | 'Growth' | 'Enterprise';
  aiMinutesUsed: number;
  aiMinutesLimit: number;
  phoneCharges: number;
  billingPeriodEnd: string;
  apiKeys: {
    service: string;
    key: string;
    lastUsed: string;
  }[];
  taxId?: string;
  nmlsId?: string;
  foundedYear?: string;
  headquarters?: string;
  website?: string;
  contactEmail?: string;
  supportPhone?: string;
  complianceOfficer?: string;
  regulatoryJurisdictions?: string[];
  businessType?: string;
  primaryLendingSectors?: string[];
  defaultInterestRate?: number;
  riskProfile?: 'Conservative' | 'Moderate' | 'Aggressive';
  companyBio?: string;
  verificationStatus?: 'Unverified' | 'Pending' | 'Verified';
}
