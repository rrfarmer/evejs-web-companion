from localization import GetByLabel
from projectdiscovery.client.projects.covid.gameplaymodes.covidretraining import OfferRetraining
from projectdiscovery.client.projects.covid.gameplaymodes.covidtransition import CovidTransition

folder = 'UI/ProjectDiscovery/Covid/Tutorial/'
client = sm.GetService('projectDiscoveryClient')
service = sm.RemoteSvc('ProjectDiscovery')
result = {
    'station': session.stationid,
    'restart': [GetByLabel(folder + label) for label in ('RestartCaption', 'RestartText', 'ButtonRestartOk', 'ButtonRestartCancel')],
    'retraining': [GetByLabel(label) for label in (OfferRetraining.TRANSITION_CONTINUE_BUTTON_LABEL_PATH, OfferRetraining.TRANSITION_SKIP_BUTTON_LABEL_PATH)],
    'transition': [GetByLabel(label) for label in (CovidTransition.TRANSITION_CONTINUE_BUTTON_LABEL_PATH, CovidTransition.TRANSITION_SKIP_BUTTON_LABEL_PATH)],
    'enabled': bool(client.is_enabled()),
    'finishedTutorial': bool(service.get_tutorial_completion_status())
}
