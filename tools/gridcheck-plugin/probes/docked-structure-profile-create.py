from eve.client.script.ui.structure.structureBrowser.nameAndDescriptionWnd import CreateProfileWnd, EditProfileNameAndDescriptionWnd
from localization import GetByLabel

result = dict(station=session.stationid, caption=GetByLabel(CreateProfileWnd.default_captionLabelPath),
              confirm=GetByLabel(CreateProfileWnd.confirmLabelPath), name=GetByLabel(CreateProfileWnd.nameLabelPath),
              description=GetByLabel(CreateProfileWnd.descriptionLabelPath),
              newProfile=GetByLabel('UI/StructureProfiles/NewProfile'),
              duplicateAction=GetByLabel('UI/StructureBrowser/DuplicateProfile'),
              editAction=GetByLabel('UI/StructureBrowser/EditNameAndDescription'),
              editCaption=GetByLabel(EditProfileNameAndDescriptionWnd.default_captionLabelPath, oldGroupName='Industrial'),
              editConfirm=GetByLabel(EditProfileNameAndDescriptionWnd.confirmLabelPath))
