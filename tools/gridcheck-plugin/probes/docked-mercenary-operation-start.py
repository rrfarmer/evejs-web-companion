from carbonui.util.bunch import Bunch
from localization import GetByLabel
from objectives.client.objective_task import sovereignty_tasks

class SampleRepository(object):
    def get_mercenary_den_activity_for_character(self, identifier):
        return Bunch(solar_system_id=session.solarsystemid2)

    def start_activity(self, identifier):
        raise AssertionError('A docked pilot must not start the operation')

assert session.stationid or session.structureid
task = Bunch(_activity_id=None, _repository=SampleRepository())
dialogs = []
original = sovereignty_tasks.prompt_player_fsd_dialog
try:
    sovereignty_tasks.prompt_player_fsd_dialog = dialogs.append
    sovereignty_tasks.StartMTOActivity.double_click.im_func(task)
finally:
    sovereignty_tasks.prompt_player_fsd_dialog = original
result = dict(station=session.stationid, system=session.solarsystemid2,
              button=GetByLabel('UI/Sovereignty/MercenaryDen/StartOperation'),
              task=GetByLabel('UI/Sovereignty/MercenaryDen/StartMTOAtMercDen'),
              dialogs=dialogs)
