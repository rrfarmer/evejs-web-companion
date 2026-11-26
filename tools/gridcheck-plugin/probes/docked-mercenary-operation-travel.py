from ballparkCommon.parkhelpers.warpSubjects import WarpSubjects
from localization import GetByLabel
from objectives.common.objectives_data import get_objective_chain_data, get_objective_type_data
from objectives.client.objective_task import get_objective_task_class

chain = get_objective_chain_data(84)
objectives = []
for objective in chain.objectives:
    tasks = get_objective_type_data(objective.objectiveType).tasks
    objectives.append(dict(key=objective.key, startActive=bool(objective.startActive),
                           tasks=[dict(key=task.key, id=task.taskType,
                                       task=get_objective_task_class(task.taskType).__name__) for task in tasks]))
result = dict(station=session.stationid, system=session.solarsystemid2, objectives=objectives,
              destination=GetByLabel('UI/Inflight/SetDestination'), undock=GetByLabel('UI/Neocom/UndockBtn'),
              jump=GetByLabel('UI/Inflight/Jump'), externalWarp=WarpSubjects.EXTERNAL_DUNGEON)
