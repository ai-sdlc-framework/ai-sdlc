package security

// ClassifyApprovalTier determines the approval tier based on context.
func ClassifyApprovalTier(securityCritical, architectureChange bool, linesChanged int) ApprovalTier {
	if securityCritical {
		return TierSecurityReview
	}
	if architectureChange {
		return TierTeamLead
	}
	if linesChanged > 500 {
		return TierTeamLead
	}
	if linesChanged > 100 {
		return TierPeerReview
	}
	return TierAuto
}

var tierOrder = map[ApprovalTier]int{
	TierAuto:           0,
	TierPeerReview:     1,
	TierTeamLead:       2,
	TierSecurityReview: 3,
}

// CompareTiers returns <0 if a < b, 0 if a == b, >0 if a > b.
func CompareTiers(a, b ApprovalTier) int {
	return tierOrder[a] - tierOrder[b]
}
