from projectdiscovery.client.projects.covid.gameplaymodes.tutorial.onegate import OneGateTutorial, BLUE_BOX_POSITION_BY_STEP
from projectdiscovery.client.projects.covid.windows.covidwindow import SAMPLE_TUTORIAL
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
        'guidedTargets': len([value for value in BLUE_BOX_POSITION_BY_STEP.values() if value]) - 2,
        'lessonOrder': [lesson.__name__ for lesson in SAMPLE_TUTORIAL],
        'remoteLessonCodes': [lesson.SAMPLE_TASK_ID for lesson in SAMPLE_TUTORIAL[1:]],
        'taskID': task.get('id'),
        'tutorial': task.get('isTutorial'),
        'dimensions': assets.get('dimensions')
    }

result = measure()
