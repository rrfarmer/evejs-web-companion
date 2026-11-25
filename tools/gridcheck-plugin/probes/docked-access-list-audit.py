from eve.client.script.ui.structure.accessGroups.auditLogEntry import AuditLogGroupChanges, AuditLogMemberChanges
from eve.client.script.ui.structure.accessGroups.accessGroupsController import AccessGroupsController
from utillib import KeyVal


def observe():
    calls = []
    def logs(group_id):
        calls.append(group_id)
        return []
    remote = KeyVal(GetGroupLogs=logs)
    controller = KeyVal(remoteSvc=remote, groupByGroupID={123: KeyVal(creatorID=session.charid),
                                                         124: KeyVal(creatorID=session.corpid)})
    AccessGroupsController.GetGroupLogs.im_func(controller, 123)
    AccessGroupsController.GetGroupLogs.im_func(controller, 124)
    created = AuditLogGroupChanges.GetTextAndTextureForEvent(KeyVal(actionID=1, characterID=session.charid))
    added = AuditLogMemberChanges.GetTextAndTextureForEvent(KeyVal(characterID=session.charid, ownerID=0,
                                                                  oldMembershipType=None, newMembershipType=0))
    return {'stationID': session.stationid, 'calls': calls, 'created': created, 'added': added}


result = observe()
