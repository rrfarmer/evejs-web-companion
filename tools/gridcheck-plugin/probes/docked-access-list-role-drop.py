from eve.client.script.ui.structure.accessGroups.accessGroupsController import AccessGroupsController
from eve.client.script.ui.structure.accessGroups.dropBar import DropBar
from eve.client.script.ui.structure.accessGroups.ownerGroupUtils import GetOwnerIDsAndMembershipTypeFromNodes
from ownergroups.ownergroupsUIUtil import ACCESS_SORT_ORDER, GetChangeRestrictions
from utillib import KeyVal


class Observer(object):
    def __init__(self):
        self.calls = []

    def GetMembers(self, groupID):
        return {session.charid: 0}

    def SetGroupMembersWithSameRight(self, groupID, memberIDs, role):
        AccessGroupsController.SetGroupMembersWithSameRight.im_func(self, groupID, memberIDs, role)

    def _GetNewAndOldMemberInfo(self, memberIDs, existing, role):
        return AccessGroupsController._GetNewAndOldMemberInfo.im_func(self, memberIDs, existing, role)

    def UpdateMembershipTypes(self, groupID, memberIDs, role, **kwargs):
        self.calls.append(['update', groupID, memberIDs, role])
        return []

    def AddMembers(self, groupID, members, **kwargs):
        self.calls.append(['add', groupID, sorted(members.items())])
        return []

    def GetUpdateMemberDict(self, *args):
        return {}

    def DisplayWarningIfNeeded(self, **kwargs):
        pass


def text_link(typeID, itemID):
    return KeyVal(__guid__='TextLink', url='showinfo:%s//%s' % (typeID, itemID))


def observe():
    observer = Observer()
    bar = KeyVal(controller=observer, currentGroupID=123)
    DropBar.AddGroupMembersWithMembershipType.im_func(bar, [session.charid, session.charid + 1], 1)
    accepted = [bool(GetOwnerIDsAndMembershipTypeFromNodes([text_link(typeID, session.charid)]))
                for typeID in (const.typeCharacter, const.typeCorporation, const.typeAlliance, const.typeSolarSystem)]
    return {'stationID': session.stationid, 'order': ACCESS_SORT_ORDER, 'acceptedLinks': accepted,
            'restrictions': [GetChangeRestrictions(role) for role in (2, 1, 0)],
            'calls': observer.calls}


result = observe()
