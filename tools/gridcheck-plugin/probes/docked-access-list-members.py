from eve.client.script.ui.structure.accessGroups.accessGroupMemberCont import AccessGroupMemberCont
from eve.client.script.ui.structure.accessGroups.accessGroupsController import AccessGroupsController
from localization import GetByLabel
from ownergroups.ownergroupConst import PUBLIC_MEMBER_ID
from ownergroups.ownergroupsUIUtil import ACCESS_SORT_ORDER, membershipTypeLabelPath
from utillib import KeyVal


class MemberObserver(object):
    def __init__(self):
        self.membersByGroupID = {}
        self.remoteSvc = self
        self.requests = []

    def GetMembers(self, groupID):
        self.requests.append(groupID)
        return [KeyVal(memberID=session.charid, membershipType=2),
                KeyVal(memberID=session.corpid, membershipType=1),
                KeyVal(memberID=PUBLIC_MEMBER_ID, membershipType=0)]


def observe():
    observer = MemberObserver()
    groupID = 123
    read = AccessGroupsController.GetMembers.im_func
    members = read(observer, groupID)
    read(observer, groupID)
    sort_value = AccessGroupMemberCont.GetSortValue.im_func
    roles = [GetByLabel(membershipTypeLabelPath[role]) for role in ACCESS_SORT_ORDER]
    return {
        'stationID': session.stationid,
        'requests': observer.requests,
        'members': sorted(members.items()),
        'publicName': AccessGroupMemberCont._GetOwnerInfoAndName.im_func(None, PUBLIC_MEMBER_ID)[1],
        'roleOrder': ACCESS_SORT_ORDER,
        'roles': roles,
        'ownerOrder': [sort_value(None, 0, 'A', typeID)[1]
                       for typeID in (PUBLIC_MEMBER_ID, const.typeAlliance, const.typeCorporation, const.typeCharacter)],
    }


result = observe()
