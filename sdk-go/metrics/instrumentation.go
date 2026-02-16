package metrics

// InstrumentEnforcement records a gate enforcement result.
func InstrumentEnforcement(store MetricStore, gateName string, passed bool) {
	labels := map[string]string{"gate": gateName}
	if passed {
		v, _ := store.Get("gate-evaluations-passed", labels)
		store.Record("gate-evaluations-passed", v+1, labels)
	} else {
		v, _ := store.Get("gate-evaluations-failed", labels)
		store.Record("gate-evaluations-failed", v+1, labels)
	}
	v, _ := store.Get("gate-evaluations-total", labels)
	store.Record("gate-evaluations-total", v+1, labels)
}

// InstrumentExecutor records an orchestration step result.
func InstrumentExecutor(store MetricStore, stepName string, succeeded bool) {
	labels := map[string]string{"step": stepName}
	v, _ := store.Get("steps-executed", labels)
	store.Record("steps-executed", v+1, labels)
	if !succeeded {
		f, _ := store.Get("steps-failed", labels)
		store.Record("steps-failed", f+1, labels)
	}
}

// InstrumentReconciler records a reconciliation cycle.
func InstrumentReconciler(store MetricStore, resourceKind string, errored bool) {
	labels := map[string]string{"kind": resourceKind}
	v, _ := store.Get("reconcile-loops", labels)
	store.Record("reconcile-loops", v+1, labels)
	if errored {
		e, _ := store.Get("reconcile-errors", labels)
		store.Record("reconcile-errors", e+1, labels)
	}
}

// InstrumentAutonomy records a promotion or demotion attempt.
func InstrumentAutonomy(store MetricStore, agentName string, isPromotion bool) {
	labels := map[string]string{"agent": agentName}
	if isPromotion {
		v, _ := store.Get("promotion-attempts", labels)
		store.Record("promotion-attempts", v+1, labels)
	} else {
		v, _ := store.Get("demotion-attempts", labels)
		store.Record("demotion-attempts", v+1, labels)
	}
}
