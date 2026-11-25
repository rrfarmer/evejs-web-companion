from eve.client.script.ui.structure.accessGroups.nameAndDescriptionWnd import AccessGroupsCreateWnd, AccessGroupsEditGroup
from eve.client.script.ui.structure.accessGroups.menuProvider import MenuProvider, MEMBERSHIP_TYPE_ADMIN
from localization import GetByLabel
from utillib import KeyVal


class EditorObserver(object):
    def __init__(self):
        self.calls = []

    def OnCreateGroup(self, name, description):
        self.calls.append(['create', name, description])

    def EditGroupNameAndDescription(self, groupID, name, description):
        self.calls.append(['edit', groupID, name, description])

    def Delete(self, groupID):
        self.calls.append(['delete', groupID])


def menu_actions(observer, creatorID, membershipType):
    group = KeyVal(groupID=123, creatorID=creatorID, membershipType=membershipType)
    entries = MenuProvider().GetMenuForGroupID(KeyVal(groupInfo=group), observer)
    return [entry[1].__name__ for entry in entries if entry is not None]


def observe():
    controller = EditorObserver()
    group = KeyVal(groupID=123, name='Probe list', description='Probe description')
    create = AccessGroupsCreateWnd(controller=controller)
    edit = AccessGroupsEditGroup(controller=controller, groupInfo=group)
    try:
        edit_values = [edit.groupNameField.GetValue(), edit.groupDescField.GetValue()]
        create.groupNameField.SetText('  Observed list  ')
        create.OnConfirmClicked()
        edit.groupDescField.SetText('  Observed description  ')
        edit.OnConfirmClicked()
        return {
            'stationID': session.stationid,
            'createCaption': GetByLabel(create.default_captionLabelPath),
            'createButton': GetByLabel(create.confirmLabelPath),
            'editCaption': GetByLabel(edit.default_captionLabelPath, oldGroupName=group.name),
            'saveButton': GetByLabel(edit.confirmLabelPath),
            'editValues': edit_values,
            'calls': controller.calls,
            'personalAdminActions': menu_actions(controller, session.charid, MEMBERSHIP_TYPE_ADMIN),
            'personalMemberActions': menu_actions(controller, session.charid, 0),
            'corporationAdminActions': menu_actions(controller, session.corpid, MEMBERSHIP_TYPE_ADMIN),
        }
    finally:
        for window in (create, edit):
            if not window.destroyed:
                window.CloseByUser()


result = observe()
