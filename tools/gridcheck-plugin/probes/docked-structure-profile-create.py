from eve.client.script.ui.structure.structureBrowser.nameAndDescriptionWnd import CreateProfileWnd, EditProfileNameAndDescriptionWnd
from eve.client.script.ui.structure.structureBrowser.entries.structureProfileEntry import StructureProfileEntry
from eve.client.script.ui.structure.structureSettings.controllers.slimProfileController import SlimStructureProfileController
from localization import GetByLabel
from types import FunctionType
from utillib import KeyVal

deleteDialog = cfg.GetMessage('DeleteStructureProfile', None, onNotFound='raise')
inUseMessage = cfg.GetMessage('CannotDeleteStructureProfileInUse', {'numStructures': 3}, onNotFound='raise')

defaultPath = 'UI/StructureBrowser/SetDefaultProfile'
current = SlimStructureProfileController(1, KeyVal(isDefault=True))
candidate = SlimStructureProfileController(3, KeyVal(isDefault=False))

def offers_default(controller, roles):
    entry = KeyVal(profileController=controller, EditNameAndDescription=None, DuplicateProfile=None,
                   DeleteProfile=None, SetDefaultProfile=None)
    method = StructureProfileEntry.GetMenu.im_func
    context = dict(method.func_globals, session=KeyVal(corprole=roles, role=0), MenuLabel=lambda path: path)
    return any(item[0] == defaultPath for item in FunctionType(method.func_code, context)(entry))

calls = []
fakeRemote = KeyVal(SetDefaultProfile=lambda profileID: calls.append(profileID))
method = SlimStructureProfileController.SetDefaultProfile.im_func
set_default = FunctionType(method.func_code, dict(method.func_globals, sm=KeyVal(RemoteSvc=lambda name: fakeRemote)))
set_default(current)
set_default(candidate)

result = dict(station=session.stationid, caption=GetByLabel(CreateProfileWnd.default_captionLabelPath),
              confirm=GetByLabel(CreateProfileWnd.confirmLabelPath), name=GetByLabel(CreateProfileWnd.nameLabelPath),
              description=GetByLabel(CreateProfileWnd.descriptionLabelPath),
              newProfile=GetByLabel('UI/StructureProfiles/NewProfile'),
              duplicateAction=GetByLabel('UI/StructureBrowser/DuplicateProfile'),
              deleteAction=GetByLabel('UI/StructureBrowser/DeleteProfile'),
              deleteTitle=deleteDialog.title, deleteText=deleteDialog.text,
              deleteInUse=inUseMessage.text,
              defaultAction=GetByLabel(defaultPath), defaultCalls=calls,
              defaultOffered=[offers_default(current, const.corpRoleStationManager),
                              offers_default(candidate, const.corpRoleStationManager), offers_default(candidate, 0)],
              editAction=GetByLabel('UI/StructureBrowser/EditNameAndDescription'),
              editCaption=GetByLabel(EditProfileNameAndDescriptionWnd.default_captionLabelPath, oldGroupName='Industrial'),
              editConfirm=GetByLabel(EditProfileNameAndDescriptionWnd.confirmLabelPath))
