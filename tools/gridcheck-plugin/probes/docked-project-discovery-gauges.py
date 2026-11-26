from localization import GetByLabel
from projectdiscovery.client.projects.covid.ui import results, rewards
from projectdiscovery.client.projects.covid.gameplaymodes.covidproject import FlowStep

service = sm.RemoteSvc('ProjectDiscovery')
result = {
    'station': session.stationid,
    'labels': [GetByLabel(results.LABEL_PATH_ACCURACY)] + [
        GetByLabel(results.LABEL_PATH_SMALL_GAUGE_DESCRIPTION[name]) for name in
        (results.HIGH_SCORE_GAUGE_NAME, results.PAR_GAUGE_NAME, results.AVERAGE_GAUGE_NAME)],
    'experience': GetByLabel(rewards.LABEL_PATH_EXPERIENCE),
    'steps': [FlowStep.DRAW, FlowStep.RESULTS, FlowStep.REWARDS],
    'thresholds': [[rank, service.get_total_needed_xp(rank)] for rank in (3, 4, 5, 6)]
}
