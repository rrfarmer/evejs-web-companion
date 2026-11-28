import blue
from carbonui.uicore import uicore
from eve.client.script.ui.skillPlan.skillPlanDockablePanel import SkillPlanDockablePanel
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName
from eve.common.script.sys import idCheckers

names = ('applySkillPointsBtn', 'skillplans_certified_tab', 'skillplans_corp_tab', 'skillplans_personal_tab',
         'skill_catalogue_tab', 'skill_plans_tab', 'skillqueue')
ids = ['unique_UI_' + name for name in names]
catalog = sm.GetService('helpPointer').GetHighlightByElementName()
rows = [dict(name=name, label=catalog[name].label, texture=catalog[name].texturePath,
             chain=FindChainForPointer(name)) for name in ids if name in catalog]
opened = SkillPlanDockablePanel.GetIfOpen()
if not opened:
    uicore.cmd.OpenSkillsWindow()
window = SkillPlanDockablePanel.GetIfOpen()
try:
    blue.pyos.synchro.SleepWallclock(500)
    anchors = GetScreenElementsByUniqueName(ids)
    visible = dict((name, list(element.GetAbsolute())) for name, element in anchors.iteritems()
                   if element and not element.destroyed and element.IsVisible())
    result = dict(build=3698585, station=session.stationid, corporation=session.corpid,
                  playerCorporation=idCheckers.IsPlayerCorporation(session.corpid), rows=rows, visible=visible)
finally:
    if window and not opened:
        window.Close()
