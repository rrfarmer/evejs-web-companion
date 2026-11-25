from eve.client.script.ui.shared.industry.browserResearch import HEADERS, NO_CONTENT_HINT
from localization import GetByLabel


def observe():
    missions, research = sm.GetService('journal').GetMyAgentJournalDetails()
    return {
        'station': session.stationid,
        'headers': [GetByLabel(label) for label in HEADERS],
        'empty': GetByLabel(NO_CONTENT_HINT),
        'missions': len(missions),
        'research': [list(row) for row in research],
    }


result = observe()
