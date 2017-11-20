import { IPromise } from 'angular';
import * as React from 'react';
import * as ReactGA from 'react-ga';
import { Transition } from '@uirouter/core';
import { get } from 'lodash';
import { BindAll } from 'lodash-decorators';
import { $timeout, $q } from 'ngimport';
import { Subscription } from 'rxjs';

import { Application } from 'core/application';
import { IPipeline, IPipelineCommand } from 'core/domain';
import { InsightFilterStateModel } from 'core/insight/insightFilterState.model';
import { ReactInjector } from 'core/reactShims';
import { Tooltip } from 'core/presentation/Tooltip';

import { CreatePipeline } from 'core/pipeline/config/CreatePipeline';
import { ExecutionFilters } from 'core/pipeline/filter/ExecutionFilters';
import { ExecutionGroups } from './executionGroup/ExecutionGroups';
import { FilterTags } from 'core/filterModel';
import { Spinner } from 'core/widgets/spinners/Spinner';

import './executions.less';

export interface IExecutionsProps {
  app: Application;
}

export interface IExecutionsState {
  initializationError?: boolean;
  insightFilterStateModel: InsightFilterStateModel;
  loading: boolean;
  sortFilter: any;
  tags: any[];
  triggeringExecution: boolean;
}

@BindAll()
export class Executions extends React.Component<IExecutionsProps, IExecutionsState> {
  private executionsRefreshUnsubscribe: Function;
  private groupsUpdatedSubscription: Subscription;
  private locationChangeUnsubscribe: Function;

  private filterCountOptions = [1, 2, 5, 10, 20, 30, 40, 50];

  constructor(props: IExecutionsProps) {
    super(props);

    const { app } = props;
    const { executionFilterModel, insightFilterStateModel } = ReactInjector;
    if (executionFilterModel.mostRecentApplication !== app.name) {
      executionFilterModel.asFilterModel.groups = [];
      executionFilterModel.mostRecentApplication = app.name;
    }

    if (app.notFound) { return; }

    app.setActiveState(app.executions);

    this.state = {
      insightFilterStateModel,
      loading: true,
      sortFilter: executionFilterModel.asFilterModel.sortFilter,
      tags: [],
      triggeringExecution: false,
    };

    app.executions.activate();
    app.pipelineConfigs.activate();
  }

  private clearFilters(): void {
    ReactInjector.executionFilterService.clearFilters();
    this.updateExecutionGroups(true);
  }

  private forceUpdateExecutionGroups(): void {
    this.updateExecutionGroups(true);
  }

  private updateExecutionGroups(reload?: boolean): void {
    this.normalizeExecutionNames();
    const { app } = this.props;
    if (reload) {
      app.executions.refresh(true);
      app.executions.reloadingForFilters = true;
    } else {
      ReactInjector.executionFilterService.updateExecutionGroups(app);
      this.groupsUpdated();
      // updateExecutionGroups is debounced by 25ms, so we need to delay setting the loading flag a bit
      $timeout(() => { this.setState({ loading: false }) }, 50);
    }
  }

  private groupsUpdated(): void {
    this.setState({ tags: ReactInjector.executionFilterModel.asFilterModel.tags });
  }

  private dataInitializationFailure(): void {
    this.setState({ loading: false, initializationError: true });
  }

  private normalizeExecutionNames(): void {
    const { app } = this.props;
    if (app.executions.loadFailure) {
      this.dataInitializationFailure();
    }
    const executions = app.executions.data || [];
    const configurations: any[] = app.pipelineConfigs.data || [];
    executions.forEach((execution: any) => {
      if (execution.pipelineConfigId) {
        const configMatch = configurations.find((c: any) => c.id === execution.pipelineConfigId);
        if (configMatch) {
          execution.name = configMatch.name;
        }
      }
    });
  }

  private expand(): void {
    ReactGA.event({ category: 'Pipelines', action: 'Expand All' });
    ReactInjector.executionFilterModel.expandSubject.next(true);
  }

  private collapse(): void {
    ReactGA.event({ category: 'Pipelines', action: 'Collapse All' });
    ReactInjector.executionFilterModel.expandSubject.next(false);
  }

  private startPipeline(command: IPipelineCommand): IPromise<void> {
    this.setState({ triggeringExecution: true });
    return ReactInjector.pipelineConfigService.triggerPipeline(this.props.app.name, command.pipelineName, command.trigger).then(
      (newPipelineId: string) => {
        const monitor = ReactInjector.executionService.waitUntilNewTriggeredPipelineAppears(this.props.app, newPipelineId);
        monitor.then(() => this.setState({ triggeringExecution: false }));
      },
      () => this.setState({ triggeringExecution: false })
    );
  };

  private triggerPipeline(): void {
    ReactGA.event({ category: 'Pipelines', action: 'Trigger Pipeline (top level)' });
    // TODO: Convert the modal to react
    ReactInjector.modalService.open({
      templateUrl: require('../manualExecution/manualPipelineExecution.html'),
      controller: 'ManualPipelineExecutionCtrl as vm',
      resolve: {
        pipeline: (): IPipeline => null,
        application: () => this.props.app,
      }
    }).result.then((command) => this.startPipeline(command)).catch(() => {});
  };

  private scrollIntoView(delay = 200): void {
    ReactInjector.scrollToService.scrollTo('#execution-' + ReactInjector.$stateParams.executionId, '.all-execution-groups', 225, delay);
  }

  public handleTransitionSuccess(transition: Transition): void {
    const toParams = transition.params('to');
    const fromParams = transition.params('from');
    // if we're navigating to a different execution on the same page, scroll the new execution into view
    // or, if we are navigating back to the same execution after scrolling down the page, scroll it into view
    // but don't scroll it into view if we're navigating to a different stage in the same execution
    let shouldScroll = false;
    if (transition.to.name.indexOf(transition.from.name) === 0 && toParams.application === fromParams.application && toParams.executionId) {
      shouldScroll = true;
      if (toParams.executionId === fromParams.executionId && toParams.details) {
        if (toParams.stage !== fromParams.stage || toParams.step !== fromParams.step || toParams.details !== fromParams.details) {
          shouldScroll = false;
        }
      }
    }
    if (shouldScroll) {
      this.scrollIntoView(0);
    }
  }

  public componentDidMount(): void {
    this.groupsUpdatedSubscription = ReactInjector.executionFilterService.groupsUpdatedStream.subscribe(() => this.groupsUpdated());
    this.locationChangeUnsubscribe = ReactInjector.$uiRouter.transitionService.onSuccess({}, (t) => this.handleTransitionSuccess(t));

    const { app } = this.props;
    this.executionsRefreshUnsubscribe = app.executions.onRefresh(null, () => {
      this.normalizeExecutionNames();

      // if an execution was selected but is no longer present, navigate up
      const { $state } = ReactInjector;
      if ($state.params.executionId) {
        if (app.getDataSource('executions').data.every(e => e.id !== $state.params.executionId)) {
          $state.go('.^');
        }
      }
    }, () => this.dataInitializationFailure());

    $q.all([app.executions.ready(), app.pipelineConfigs.ready()]).then(() => {
      this.updateExecutionGroups();
      if (ReactInjector.$stateParams.executionId) {
        this.scrollIntoView();
      }
    });
  }

  public componentWillUnmount(): void {
    const { app } = this.props;
    app.setActiveState();
    app.executions.deactivate();
    app.pipelineConfigs.deactivate();
    this.executionsRefreshUnsubscribe();
    this.groupsUpdatedSubscription.unsubscribe();
    this.locationChangeUnsubscribe();
  }

  private showFilters(): void {
    this.state.insightFilterStateModel.pinFilters(true);
  }

  private hideFilters(): void {
    this.state.insightFilterStateModel.pinFilters(!this.state.insightFilterStateModel.filtersPinned);
  }

  private groupByChanged(event: React.ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value;
    ReactGA.event({ category: 'Pipelines', action: 'Group By', label: value });
    this.state.sortFilter.groupBy = value;
    this.updateExecutionGroups();
  }

  private showCountChanged(event: React.ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value;
    this.state.sortFilter.count = value;
    ReactGA.event({ category: 'Pipelines', action: 'Change Count', label: value });
    this.updateExecutionGroups(true);
  }

  private showDurationsChanged(event: React.ChangeEvent<HTMLInputElement>): void {
    const checked = event.target.checked;
    // TODO: Since we treat sortFilter like a store, we can force the setState for now
    //       but we should eventually convert all the sortFilters to be a valid redux
    //       (or similar) store.
    this.state.sortFilter.showStageDuration = checked;
    this.setState({ sortFilter: this.state.sortFilter });
    ReactGA.event({ category: 'Pipelines', action: 'Toggle Durations', label: checked.toString() });
  }

  public render(): React.ReactElement<Executions> {
    const { app } = this.props;
    const { insightFilterStateModel, loading, sortFilter, tags, triggeringExecution } = this.state;

    const hasPipelines = !!(get(app, 'executions.data', []).length || get(app, 'pipelineConfigs.data', []).length);

    if (!app.notFound) {
      return (
        <div className="executions-section">
          <div className={`insight ${insightFilterStateModel.filtersExpanded ? 'filters-expanded' : 'filters-collapsed'}`}>
            <div className="nav">
              <h3 className="filters-placeholder">
                <Tooltip value="Show filters">
                  <a className="btn btn-xs btn-default pin clickable" onClick={this.showFilters}>
                    <i className="fa fa-forward"/>
                  </a>
                </Tooltip>
              </h3>
              <a
                className="btn btn-xs btn-default pull-right unpin clickable"
                style={{ display: insightFilterStateModel.filtersExpanded ? '' : 'none' }}
                onClick={this.hideFilters}
              >
                <Tooltip value="Hide filters">
                  <i className="fa fa-backward"/>
                </Tooltip>
              </a>
              {!loading && <ExecutionFilters application={app}/>}
            </div>
            <div className={`full-content ${insightFilterStateModel.filtersExpanded ? 'filters-expanded' : ''} ${sortFilter.showStageDuration ? 'show-durations' : ''}`} data-scroll-id="nav-content">
              {!loading && (
                <div className="execution-groups-header">
                <h3>Pipelines</h3>
                <div className="form-group pull-right">
                  <a
                    className="btn btn-sm btn-primary clickable"
                    onClick={this.triggerPipeline}
                    style={{ pointerEvents: triggeringExecution ? 'none' : 'auto' }}
                  >
                    {triggeringExecution && (
                      <span className="pulsing">
                        <Tooltip value="Starting Execution"><span className="fa fa-cog fa-spin visible-md-inline visible-sm-inline"/></Tooltip>
                        <span className="fa fa-cog fa-spin visible-lg-inline"/>
                        <span className="visible-xl-inline">Starting Execution</span>&hellip;
                      </span>
                    )}
                    {!triggeringExecution && (
                      <span>
                        <span className="glyphicon glyphicon-play visible-lg-inline"/>
                        <Tooltip value="Start Manual Execution"><span className="glyphicon glyphicon-play visible-md-inline visible-sm-inline"/></Tooltip>
                        <span className="visible-xl-inline"> Start Manual Execution</span>
                      </span>
                    )}
                  </a>
                </div>
                <div className="pull-right">
                  <CreatePipeline application={app}/>
                </div>
                <form className="form-inline" style={{ marginBottom: '5px' }}>
                  {sortFilter.groupBy && (
                    <div className="form-group" style={{ marginRight: '20px' }}>
                      <Tooltip value="expand all">
                        <a className="btn btn-xs btn-default clickable" onClick={this.expand}>
                          <span className="glyphicon glyphicon-plus"/>
                        </a>
                      </Tooltip>
                      <Tooltip value="collapse all">
                        <a className="btn btn-xs btn-default clickable" onClick={this.collapse}>
                          <span className="glyphicon glyphicon-minus"/>
                        </a>
                      </Tooltip>
                    </div>
                  )}
                  <div className="form-group">
                    <label>Group by</label>
                    <select
                      className="form-control input-sm"
                      value={sortFilter.groupBy}
                      onChange={this.groupByChanged}
                    >
                      <option value="none">None</option>
                      <option value="name">Pipeline</option>
                      <option value="timeBoundary">Time Boundary</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Show </label>
                    <select
                      className="form-control input-sm"
                      value={sortFilter.count}
                      onChange={this.showCountChanged}
                    >
                      {this.filterCountOptions.map((count) => <option key={count} value={count}>{count}</option>)}
                    </select>
                    <span> executions per pipeline</span>
                  </div>
                  <div className="form-group checkbox">
                    <label>
                      <input
                        type="checkbox"
                        checked={sortFilter.showStageDuration}
                        onChange={this.showDurationsChanged}
                      /> stage durations
                    </label>
                  </div>
                </form>
                <FilterTags tags={tags} tagCleared={this.forceUpdateExecutionGroups} clearFilters={this.clearFilters}/>
              </div>
              )}
              {loading && <div className="horizontal center middle spinner-container"><Spinner size="medium"/></div>}
              {app.executions.reloadingForFilters && <div className="text-center transition-overlay" style={{ marginLeft: '-25px' }} />}
              {!loading && !hasPipelines && (
                <div className="text-center">
                  <h4>No pipelines configured for this application.</h4>
                </div>
              )}
              {app.executions.loadFailure && (
                <div className="text-center">
                  <h4>There was an error loading executions. We'll try again shortly.</h4>
                </div>
              )}
              {!this.state.loading && hasPipelines && <ExecutionGroups application={app} />}
            </div>
          </div>
        </div>
      );
    }
    return null;
  }
}