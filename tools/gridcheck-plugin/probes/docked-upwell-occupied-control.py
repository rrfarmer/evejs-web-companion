import blue
import uthread
from eve.client.script.ui.shared.dockedUI.controlButton import ControlButtonController
from eve.client.script.ui.shared.dockedUI.controllers.structureController import StructureController
from eve.client.script.ui.shared.dockedUI.inControlCont import ConfirmTakeControl
from localization import GetByLabel


def wait_for(read):
    for _ in xrange(60):
        value = read()
        if value:
            return value
        blue.synchro.SleepWallclock(200)
    raise RuntimeError('Timed out waiting for the structure control action')


def label_texts(container):
    for child in getattr(container, 'children', ()):
        text = getattr(child, 'text', None)
        if text:
            yield text
        for own in label_texts(child):
            yield own


def measure(action):
    sid = session.structureid
    if not sid:
        raise RuntimeError('A docked Upwell pilot is required')
    controller = StructureController(sid)
    lobby = ControlButtonController(controller)
    original_ship = session.shipid
    previous = controller.GetStructurePilot(sid)
    allowed = lobby._may_take_control()
    report = dict(pilot=session.charid, structure=sid, previous=previous, shipBefore=original_ship, allowed=allowed)
    if action in ('take', 'cancel', 'confirm') and not allowed:
        raise RuntimeError('The pilot cannot take control of the structure')
    if action == 'take':
        if previous is not None:
            raise RuntimeError('Use cancel or confirm for an occupied structure')
        lobby.execute()
        wait_for(lambda: session.shipid == sid)
    elif action in ('cancel', 'confirm'):
        if previous is None or previous == session.charid:
            raise RuntimeError('Another pilot must control the structure')
        errors = []

        def launch():
            try:
                lobby.execute()
            except Exception as exc:
                errors.append(repr(exc))

        def current_dialog():
            if errors:
                raise RuntimeError('Could not open Pilot in Control: %s' % errors[0])
            modal = uicore.registry.GetModalWindow()
            return modal if isinstance(modal, ConfirmTakeControl) else None

        uthread.new(launch)
        dialog = wait_for(current_dialog)
        report['window'] = dialog.GetCaption()
        report['buttons'] = list(label_texts(dialog.btnGroup))
        report['labels'] = list(label_texts(dialog.playerCont))
        report['occupantName'] = cfg.eveowners.Get(previous).name
        report['takeLabel'] = GetByLabel('UI/Commands/TakeStructureControl')
        if action == 'cancel':
            dialog.Cancel()
        else:
            dialog.TakeControl()
            wait_for(lambda: session.shipid == sid)
        wait_for(lambda: not current_dialog())
    elif action == 'release':
        sm.GetService('structureControl').ReleaseControl()
        wait_for(lambda: session.shipid and session.shipid != sid)
    elif action != 'observe':
        raise ValueError('Unknown structure control action')
    report.update(current=controller.GetStructurePilot(sid), shipAfter=session.shipid)
    return report


result = measure(globals().get('control_action', 'observe'))
