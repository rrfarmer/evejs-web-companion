from eve.client.script.ui.structure.structureBrowser.nameAndDescriptionWnd import CreateProfileWnd, EditProfileNameAndDescriptionWnd
from localization import GetByLabel

deleteDialog = cfg.GetMessage('DeleteStructureProfile', None, onNotFound='raise')
inUseMessage = cfg.GetMessage('CannotDeleteStructureProfileInUse', {'numStructures': 3}, onNotFound='raise')

result = dict(station=session.stationid, caption=GetByLabel(CreateProfileWnd.default_captionLabelPath),
              confirm=GetByLabel(CreateProfileWnd.confirmLabelPath), name=GetByLabel(CreateProfileWnd.nameLabelPath),
              description=GetByLabel(CreateProfileWnd.descriptionLabelPath),
              newProfile=GetByLabel('UI/StructureProfiles/NewProfile'),
              duplicateAction=GetByLabel('UI/StructureBrowser/DuplicateProfile'),
              deleteAction=GetByLabel('UI/StructureBrowser/DeleteProfile'),
              deleteTitle=deleteDialog.title, deleteText=deleteDialog.text,
              deleteInUse=inUseMessage.text,
              editAction=GetByLabel('UI/StructureBrowser/EditNameAndDescription'),
              editCaption=GetByLabel(EditProfileNameAndDescriptionWnd.default_captionLabelPath, oldGroupName='Industrial'),
              editConfirm=GetByLabel(EditProfileNameAndDescriptionWnd.confirmLabelPath))
