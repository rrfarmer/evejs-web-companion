from projectdiscovery.client.projects.covid.gameplaymodes.tutorial.onegate import OneGateTutorial
from projectdiscovery.client.projects.covid.gameplaymodes.tutorial.twogates import TwoGatesTutorial

def measure():
    discovery = sm.RemoteSvc('ProjectDiscovery')
    key = TwoGatesTutorial.SAMPLE_TASK_ID
    task = discovery.get_new_task(original_code=key, is_tutorial_task=True)
    assets = task.get('assets') or {}
    return {
        'station': session.stationid,
        'oneGateStaticTexture': OneGateTutorial.SAMPLE_TEXTURE_PATH,
        'firstRemoteTutorialCode': key,
        'taskID': task.get('id'),
        'tutorial': task.get('isTutorial'),
        'dimensions': assets.get('dimensions')
    }

result = measure()
