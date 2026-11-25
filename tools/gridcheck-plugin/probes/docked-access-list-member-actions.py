from eve.client.script.ui.structure.accessGroups.menuProvider import MenuProvider
from eve.client.script.ui.structure.accessGroups.accessGroupsController import AccessGroupsController
from utillib import KeyVal


class Observer(object):
    def __init__(self):
        self.calls = []
        self.remoteSvc = self

    def GetMembers(self, groupID):
        return {}

    def IsGroupCorpOwned(self, groupID):
        return False

    def AddMembers(self, groupID, members):
        self.calls.append([groupID, sorted(members.items())])
        return []

    def UpdateMembershipTypes(self, *args):
        pass

    def RemoveMembers(self, *args):
        pass


def actions(observer, ownRole, memberID, memberRole, ownerType):
    node = KeyVal(memberID=memberID, membershipType=memberRole, entryType=ownerType, ownerInfo=None)
    items = MenuProvider().GetMenuForMember(123, [node], ownRole, observer, False)
    return [unicode(item[0]) for item in items if item is not None]


def observe():
    observer = Observer()
    public = AccessGroupsController.AddPublicMember.im_func
    class Client(object):
        def AddMembers(self, groupID, members):
            return AccessGroupsController.AddMembers.im_func(observer, groupID, members, silently=True)
    public(Client(), 123)
    pilot = session.charid + 1
    return {
        'stationID': session.stationid,
        'addPublic': observer.calls,
        'adminOnMember': actions(observer, 2, pilot, 0, const.typeCharacter),
        'managerOnMember': actions(observer, 1, pilot, 0, const.typeCharacter),
        'managerOnAdmin': actions(observer, 1, pilot, 2, const.typeCharacter),
        'adminOnPublic': actions(observer, 2, 0, 0, 0),
        'memberOnSelf': actions(observer, 0, session.charid, 0, const.typeCharacter),
    }


result = observe()
