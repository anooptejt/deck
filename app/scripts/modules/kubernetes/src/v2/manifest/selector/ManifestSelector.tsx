import * as React from 'react';
import { Creatable, Option } from 'react-select';
import { IPromise } from 'angular';
import { Observable, Subject } from 'rxjs';
import { $q } from 'ngimport';
import { get } from 'lodash';

import {
  AppListExtractor,
  Application,
  NgReact,
  StageConstants,
  IAccountDetails,
  SETTINGS,
  StageConfigField,
  AccountSelectField,
  AccountService,
  noop,
  ScopeClusterSelector,
} from '@spinnaker/core';

import { IManifestSelector, SelectorMode } from 'kubernetes/v2/manifest/selector/IManifestSelector';
import { ManifestKindSearchService } from 'kubernetes/v2/manifest/ManifestKindSearch';

export interface IManifestSelectorProps {
  selector: IManifestSelector;
  application?: Application;
  includeSpinnakerKinds?: string[];
  modes?: SelectorMode[];
  onChange(selector: IManifestSelector): void;
}

export interface IManifestSelectorState {
  accounts: IAccountDetails[];
  selector: IManifestSelector;
  namespaces: string[];
  kinds: string[];
  resources: string[];
  loading: boolean;
}

interface ISelectorHandler {
  handles(mode: SelectorMode): boolean;
  handleModeChange(): void;
  handleKindChange(kind: string): void;
  getKind(): string;
}

const parseSpinnakerName = (spinnakerName: string): { name: string; kind: string } => {
  const [kind, name] = (spinnakerName || '').split(' ');
  return { kind, name };
};

class StaticManifestSelectorHandler implements ISelectorHandler {
  constructor(private component: ManifestSelector) {}

  public handles = (mode: SelectorMode): boolean => mode === SelectorMode.Static;

  public handleModeChange = (): void => {
    const { selector } = this.component.state;
    this.handleKindChange(selector.kind);
    selector.kind = null;
    selector.criteria = null;
    selector.cluster = null;
    this.component.setStateAndUpdateStage({ selector });
  };

  public handleKindChange = (kind: string): void => {
    const { selector } = this.component.state;
    const { name } = parseSpinnakerName(selector.manifestName);
    selector.manifestName = kind ? (name ? `${kind} ${name}` : kind) : name;
  };

  public getKind = (): string => parseSpinnakerName(this.component.state.selector.manifestName).kind;
}

class DynamicManifestSelectorHandler implements ISelectorHandler {
  constructor(private component: ManifestSelector) {}

  public handles = (mode: SelectorMode): boolean => mode === SelectorMode.Dynamic;

  public handleModeChange = (): void => {
    const { selector } = this.component.state;
    const { kind } = parseSpinnakerName(selector.manifestName);
    selector.kind = kind;
    selector.manifestName = null;
    this.component.setStateAndUpdateStage({ selector });
  };

  public handleKindChange = (kind: string): void => {
    this.component.state.selector.kind = kind;
  };

  public getKind = (): string => this.component.state.selector.kind;
}

export class ManifestSelector extends React.Component<IManifestSelectorProps, IManifestSelectorState> {
  private search$ = new Subject<{ kind: string; namespace: string; account: string }>();
  private destroy$ = new Subject<void>();
  private handlers: ISelectorHandler[];

  constructor(props: IManifestSelectorProps) {
    super(props);

    if (!this.props.selector.mode) {
      this.props.selector.mode = SelectorMode.Static;
      this.props.onChange && this.props.onChange(this.props.selector);
    }

    this.state = {
      selector: props.selector,
      accounts: [],
      namespaces: [],
      kinds: [],
      resources: [],
      loading: false,
    };
    this.handlers = [new StaticManifestSelectorHandler(this), new DynamicManifestSelectorHandler(this)];
  }

  public setStateAndUpdateStage = (state: Partial<IManifestSelectorState>, cb?: () => void): void => {
    if (state.selector && this.props.onChange) {
      this.props.onChange(state.selector);
    }
    this.setState(state as IManifestSelectorState, cb || noop);
  };

  public componentDidMount = (): void => {
    this.loadAccounts();

    this.search$
      .do(() => this.setStateAndUpdateStage({ loading: true }))
      .switchMap(({ kind, namespace, account }) => Observable.fromPromise(this.search(kind, namespace, account)))
      .takeUntil(this.destroy$)
      .subscribe(resources => {
        if (this.state.selector.manifestName == null) {
          this.handleNameChange('');
        }
        this.setStateAndUpdateStage({ loading: false, resources: resources });
      });
  };

  public componentWillUnmount = () => this.destroy$.next();

  public loadAccounts = (): IPromise<void> => {
    return AccountService.getAllAccountDetailsForProvider('kubernetes', 'v2').then(accounts => {
      const selector = this.state.selector;
      const kind = parseSpinnakerName(selector.manifestName).kind;

      this.setStateAndUpdateStage({ accounts });

      if (!selector.account && accounts.length > 0) {
        selector.account = accounts.some(e => e.name === SETTINGS.providers.kubernetes.defaults.account)
          ? SETTINGS.providers.kubernetes.defaults.account
          : accounts[0].name;
      }
      if (selector.account) {
        this.handleAccountChange(selector.account);
      }
      if (kind) {
        this.search$.next({ kind, namespace: selector.location, account: selector.account });
      }
    });
  };

  private handleAccountChange = (selectedAccount: string): void => {
    const details = (this.state.accounts || []).find(account => account.name === selectedAccount);
    if (!details) {
      return;
    }
    const namespaces = (details.namespaces || []).sort();
    const kinds = Object.entries(details.spinnakerKindMap || {})
      .filter(
        ([, spinnakerKind]) =>
          this.props.includeSpinnakerKinds && this.props.includeSpinnakerKinds.length
            ? this.props.includeSpinnakerKinds.includes(spinnakerKind)
            : true,
      )
      .map(([kind]) => kind)
      .sort();

    if (
      !this.isExpression(this.state.selector.location) &&
      namespaces.every(ns => ns !== this.state.selector.location)
    ) {
      this.state.selector.location = null;
    }
    this.state.selector.account = selectedAccount;

    this.search$.next({
      kind: parseSpinnakerName(this.state.selector.manifestName).kind || this.state.selector.kind,
      namespace: this.state.selector.location,
      account: this.state.selector.account,
    });
    this.setStateAndUpdateStage({
      namespaces,
      kinds,
      selector: this.state.selector,
    });
  };

  private handleNamespaceChange = (selectedNamespace: Option): void => {
    this.state.selector.location =
      selectedNamespace && selectedNamespace.value ? (selectedNamespace.value as string) : null;
    this.search$.next({
      kind: parseSpinnakerName(this.state.selector.manifestName).kind,
      namespace: this.state.selector.location,
      account: this.state.selector.account,
    });
    this.setStateAndUpdateStage({ selector: this.state.selector });
  };

  public handleKindChange = (kind: string): void => {
    this.modeDelegate().handleKindChange(kind);
    this.search$.next({ kind: kind, namespace: this.state.selector.location, account: this.state.selector.account });
  };

  private handleNameChange = (selectedName: string): void => {
    const { kind } = parseSpinnakerName(this.state.selector.manifestName);
    this.state.selector.manifestName = kind ? `${kind} ${selectedName}` : ` ${selectedName}`;
    this.setStateAndUpdateStage({ selector: this.state.selector });
  };

  private isExpression = (value = ''): boolean => value.includes('${');

  private search = (kind: string, namespace: string, account: string): IPromise<string[]> => {
    if (this.isExpression(account)) {
      return $q.resolve([]);
    }
    return ManifestKindSearchService.search(kind, namespace, account).then(results =>
      results.map(result => result.name).sort(),
    );
  };

  private handleModeSelect = (mode: SelectorMode) => {
    this.state.selector.mode = mode;
    this.setStateAndUpdateStage({ selector: this.state.selector }, () => {
      this.modeDelegate().handleModeChange();
    });
  };

  private handleClusterChange = ({ clusterName }: { clusterName: string }) => {
    this.state.selector.cluster = clusterName;
    this.setStateAndUpdateStage({ selector: this.state.selector });
  };

  private handleCriteriaChange = (criteria: string) => {
    this.state.selector.criteria = criteria;
    this.setStateAndUpdateStage({ selector: this.state.selector });
  };

  private modeDelegate = (): ISelectorHandler =>
    this.handlers.find(handler => handler.handles(this.state.selector.mode || SelectorMode.Static));

  private promptTextCreator = (text: string) => `Use custom expression: ${text}`;

  public render() {
    const { TargetSelect } = NgReact;
    const mode = this.state.selector.mode || SelectorMode.Static;
    const modes = this.props.modes || [mode];
    const { selector, accounts, kinds, namespaces, resources, loading } = this.state;
    const kind = this.modeDelegate().getKind();
    const name = parseSpinnakerName(selector.manifestName).name;
    const resourceNames = resources.map(resource => parseSpinnakerName(resource).name);
    const clusters = AppListExtractor.getClusters(
      this.props.application ? [this.props.application] : [],
      serverGroup =>
        AppListExtractor.clusterFilterForCredentialsAndRegion(selector.account, selector.location)(serverGroup) &&
        get(serverGroup, 'serverGroupManagers.length', 0) === 0 &&
        parseSpinnakerName(serverGroup.name).kind === this.modeDelegate().getKind(),
    );

    return (
      <>
        <StageConfigField label="Account">
          <AccountSelectField
            component={selector}
            field="account"
            accounts={accounts}
            onChange={this.handleAccountChange}
            provider="'kubernetes'"
          />
        </StageConfigField>
        <StageConfigField label="Namespace">
          <Creatable
            clearable={false}
            value={{ value: selector.location, label: selector.location }}
            options={namespaces.map(ns => ({ value: ns, label: ns }))}
            onChange={this.handleNamespaceChange}
            promptTextCreator={this.promptTextCreator}
          />
        </StageConfigField>
        <StageConfigField label="Kind">
          <Creatable
            clearable={false}
            value={{ value: kind, label: kind }}
            options={kinds.map(k => ({ value: k, label: k }))}
            onChange={(option: Option<string>) => this.handleKindChange(option && option.value)}
            promptTextCreator={this.promptTextCreator}
          />
        </StageConfigField>
        {modes.length > 1 && (
          <StageConfigField label="Selector">
            <div className="radio">
              <label htmlFor="static">
                <input
                  type="radio"
                  onChange={() => this.handleModeSelect(SelectorMode.Static)}
                  checked={mode === SelectorMode.Static}
                  id="static"
                />{' '}
                Choose a static target
              </label>
            </div>
            <div className="radio">
              <label htmlFor="dynamic">
                <input
                  type="radio"
                  onChange={() => this.handleModeSelect(SelectorMode.Dynamic)}
                  checked={mode === SelectorMode.Dynamic}
                  id="dynamic"
                />{' '}
                Choose a target dynamically
              </label>
            </div>
          </StageConfigField>
        )}
        {modes.includes(SelectorMode.Static) &&
          mode === SelectorMode.Static && (
            <StageConfigField label="Name">
              <Creatable
                isLoading={loading}
                clearable={false}
                value={{ value: name, label: name }}
                options={resourceNames.map(r => ({ value: r, label: r }))}
                onChange={(option: Option) => this.handleNameChange(option ? (option.value as string) : '')}
                promptTextCreator={this.promptTextCreator}
              />
            </StageConfigField>
          )}
        {modes.includes(SelectorMode.Dynamic) &&
          mode === SelectorMode.Dynamic && (
            <>
              <StageConfigField label="Cluster">
                <ScopeClusterSelector
                  clusters={clusters}
                  model={selector.cluster}
                  onChange={this.handleClusterChange}
                />
              </StageConfigField>
              <StageConfigField label="Target">
                <TargetSelect
                  onChange={this.handleCriteriaChange}
                  model={{ target: selector.criteria }}
                  options={StageConstants.MANIFEST_CRITERIA_OPTIONS}
                />
              </StageConfigField>
            </>
          )}
      </>
    );
  }
}
