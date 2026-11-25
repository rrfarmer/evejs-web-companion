from eve.client.script.ui.structure.accessGroups.accessGroupListCont import GroupListCont
from eve.client.script.ui.structure.accessGroups.accessGroupMemberCont import AccessGroupMemberCont
from eve.client.script.ui.structure.accessGroups.accessGroupsController import AccessGroupsController
from eve.client.script.ui.structure.accessGroups.searchCont import SearchCont
from localization import GetByLabel
from utillib import KeyVal


class Observer(object):
    def __init__(self, text, rows):
        self.searchField = KeyVal(GetValue=lambda: text)
        self.controller = self
        self.rows = rows
        self.results = None
        self.primes = 0

    def PrimeMembers(self):
        self.primes += 1
        return self.rows

    def GetMemberName(self, memberID):
        return {31: 'client observer', 32: 'test two'}[memberID]

    def SetCurrentSearchResults(self, results):
        self.results = results

    def GetMembers(self, groupID):
        return self.rows[groupID]


def observe():
    rows = {123: {31: 1, 32: 0}, 124: {32: 0}}
    short = Observer('Ob', rows)
    match = Observer('OBS', rows)
    SearchCont.DoSearch.im_func(short)
    SearchCont.DoSearch.im_func(match)
    flags = [GroupListCont.IsNormalGroup.im_func(None, groupID, match.results) for groupID in (123, 124)]
    shown = [sorted(AccessGroupMemberCont.GetFilteredMembers.im_func(match, groupID, match.results))
             for groupID in (123, 124)]
    calls = []
    def get_multiple(groupIDs):
        calls.append(sorted(groupIDs))
        return {123: [KeyVal(memberID=31, membershipType=1)], 124: [KeyVal(memberID=32, membershipType=0)]}
    remote = KeyVal(remoteSvc=KeyVal(GetMembersForMultipleGroups=get_multiple))
    AccessGroupsController._GetUncachedMembers.im_func(remote, {123, 124})
    try:
        public_name = cfg.eveowners.Get(0).name
    except Exception:
        public_name = None
    return {'stationID': session.stationid, 'shortPrimes': short.primes,
            'matchedGroups': sorted(match.results[1]), 'normalRows': flags, 'memberRows': shown,
            'batch': calls, 'emptyHint': GetByLabel('UI/Structures/AccessGroups/SearchNoContentHint'),
            'publicName': public_name}


result = observe()
