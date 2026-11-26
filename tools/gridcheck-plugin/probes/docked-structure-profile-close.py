from eve.client.script.ui.structure.structureBrowser.controllers.structureBrowserController import StructureBrowserController
from eve.client.script.ui.structure.structureBrowser.structureBrowserWnd import StructureBrowserWnd
from localization import GetByLabel
from types import FunctionType
from utillib import KeyVal
import carbonui.const as uiconst

def observe_close(dirty, answer):
    events = []

    def prompt(key, phrases, buttons):
        events.append(['prompt', key, phrases['header'], phrases['question'], buttons])
        return answer

    leaveMethod = StructureBrowserController.PlayerWantsToLeaveProfile.im_func
    leave = FunctionType(leaveMethod.func_code, dict(leaveMethod.func_globals, prompt_player_fsd_dialog=prompt))
    controller = KeyVal(HasProfileChanged=lambda: dirty, SetProfileChangedValue=lambda value: events.append(['dirty', value]))
    controller.PlayerWantsToLeaveProfile = lambda: leave(controller)
    services = KeyVal(GetStructureBrowserController=lambda: controller)
    window = KeyVal(CloseByUser=lambda *args: events.append(['close']))
    closeMethod = StructureBrowserWnd.CloseByUser.im_func
    close = FunctionType(closeMethod.func_code, dict(closeMethod.func_globals, sm=KeyVal(GetService=lambda name: services), Window=window))
    close(None)
    return events

result = dict(station=session.stationid, title=GetByLabel('UI/StructureBrowser/UnsavedChanges'),
              question=GetByLabel('UI/StructureBrowser/UnsavedChangesQuestion'),
              clean=observe_close(False, uiconst.ID_NO),
              keep=observe_close(True, uiconst.ID_NO), discard=observe_close(True, uiconst.ID_YES))
