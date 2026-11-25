# Read native labels and collect the row action's wire arguments without assigning a profile.
from localization import GetByLabel
from eve.client.script.ui.structure.structureSettings.controllers.allProfilesController import AllStructureProfileController

class Remote(object):
    def __init__(self):
        self.calls = []

    def ChangeProfiles(self, structure_ids, profile_id):
        self.calls.append([structure_ids, profile_id])

class Controller(object):
    def __init__(self):
        self.remoteStructureSvc = Remote()

controller = Controller()
AllStructureProfileController.UpdateProfileIDForStructures.im_func(controller, 3, [1030000000001L, 1030000000002L])
result = {'single': GetByLabel('UI/StructureBrowser/SetProfile'),
          'bulk': GetByLabel('UI/StructureBrowser/SetProfileMany', numSelected=2),
          'calls': controller.remoteStructureSvc.calls}
