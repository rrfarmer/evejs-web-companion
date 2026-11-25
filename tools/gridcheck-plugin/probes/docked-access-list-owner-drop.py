from eve.client.script.ui.structure.accessGroups.accessGroupEntry import AccessGroupEntry
from eve.client.script.ui.structure.accessGroups.accessGroupMemberCont import AccessGroupMemberCont
from eve.client.script.ui.structure.accessGroups.accessGroupsController import AccessGroupsController
from utillib import KeyVal


class Observer(object):
    def __init__(self):
        self.remoteSvc = self
        self.requests = []

    def GetMembers(self, groupID):
        return {session.charid: 0}

    def IsGroupCorpOwned(self, groupID):
        return False

    def AddMembers(self, groupID, members):
        self.requests.append([groupID, sorted(members.items())])
        return []


class Controller(object):
    def __init__(self):
        self.observer = Observer()

    def AddMembers(self, groupID, members):
        AccessGroupsController.AddMembers.im_func(self.observer, groupID, members, silently=True)


def observe():
    controller = Controller()
    row = KeyVal(controller=controller, groupID=123)
    pane = KeyVal(controller=controller, currentGroupID=124)
    owners = [KeyVal(__guid__='listentry.User', itemID=session.charid, membershipType=2),
              KeyVal(__guid__='listentry.User', itemID=session.charid + 1, membershipType=1)]
    AccessGroupEntry.OnDropData.im_func(row, None, owners)
    AccessGroupMemberCont.OnDropDataInScroll.im_func(pane, None, owners)
    link = KeyVal(__guid__='TextLink', url='showinfo:%s//%s' % (const.typeCorporation, session.corpid))
    AccessGroupEntry.OnDropData.im_func(row, None, [link])
    return {'stationID': session.stationid, 'knownMember': session.charid,
            'newMember': session.charid + 1, 'requests': controller.observer.requests}


result = observe()
