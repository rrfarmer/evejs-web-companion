import blue
from carbonui.uicore import uicore
from eve.client.script.ui.skillPlan.skillPlanDockablePanel import SkillPlanDockablePanel
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName
import inventorycommon.const as invconst


def observe():
    key = 'unique_UI_applySkillPointsBtn'
    if not SkillPlanDockablePanel.GetIfOpen():
        uicore.cmd.OpenSkillsWindow()
    blue.pyos.synchro.SleepWallclock(600)
    button = GetScreenElementsByUniqueName([key]).get(key)
    queue = sm.GetService('skillqueue').GetQueue()
    skills = sm.GetService('skills')
    return dict(build=3698585, station=session.stationid,
                queue=[[item.trainingTypeID, item.trainingToLevel] for item in queue],
                free=skills.GetFreeSkillPoints(),
                texture=button.texturePath if button else None,
                injector=invconst.typeSkillInjector, alphaInjector=invconst.typeAlphaTrainingInjector)


result = observe()
