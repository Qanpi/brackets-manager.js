import { Participant, Duels, Duel, InputStage, ParticipantSlot, Match, SeedOrdering, MatchGame, Stage, Group, Round } from 'brackets-model';
import { ordering, defaultMinorOrdering } from './ordering';
import { BracketsManager } from '.';
import { IStorage } from './storage';
import * as helpers from './helpers';

export async function create(this: BracketsManager, tournamentId: number, stage: InputStage) {
    const create = new Create(this.storage, tournamentId, stage);
    return create.run();
}

class Create {

    private storage: IStorage;
    private tournamentId: number;
    private stage: InputStage;

    constructor(storage: IStorage, tournamentId: number, stage: InputStage) {
        this.storage = storage;
        this.tournamentId = tournamentId;
        this.stage = stage;
    }

    /**
     * Run the creation process.
     */
    public run() {
        switch (this.stage.type) {
            case 'round_robin':
                return this.roundRobin();
            case 'single_elimination':
                return this.singleElimination();
            case 'double_elimination':
                return this.doubleElimination();
            default:
                throw Error('Unknown stage type.');
        }
    }

    /**
     * Creates a round-robin stage.
     * 
     * Group count must be given. It will distribute participants in groups and rounds.
     */
    private async roundRobin() {
        if (!this.stage.settings || !this.stage.settings.groupCount) throw Error('You must specify a group count for round-robin stages.');

        if (Array.isArray(this.stage.settings.seedOrdering)
            && this.stage.settings.seedOrdering.length !== 1) throw Error('You must specify one seed ordering method.');

        // Default method for round-robin groups: Effort balanced.
        const method = this.getOrdering(0, 'groups') || 'groups.effort_balanced';

        const stageCount = await this.getStageCount();
        const stageId = await this.storage.insert<Stage>('stage', {
            tournament_id: this.tournamentId,
            name: this.stage.name,
            type: this.stage.type,
            number: stageCount + 1,
        });

        const slots = await this.getSlots();
        const ordered = ordering[method](slots, this.stage.settings.groupCount);
        const groups = helpers.makeGroups(ordered, this.stage.settings.groupCount);

        for (let i = 0; i < groups.length; i++)
            await this.createGroup(`Group ${i + 1}`, stageId, i + 1, groups[i]);
    }

    /**
     * Creates a single elimination stage.
     * 
     * One bracket and optionally a consolation final between semi-final losers.
     */
    private async singleElimination() {
        if (this.stage.settings && Array.isArray(this.stage.settings.seedOrdering) &&
            this.stage.settings.seedOrdering.length !== 1) throw Error('You must specify one seed ordering method.');

        const stageCount = await this.getStageCount();
        const stageId = await this.storage.insert<Stage>('stage', {
            tournament_id: this.tournamentId,
            name: this.stage.name,
            type: this.stage.type,
            number: stageCount + 1,
        });

        const slots = await this.getSlots();
        const { losers } = await this.createStandardBracket('Bracket', stageId, 1, slots);

        const semiFinalLosers = losers[losers.length - 2];
        if (this.stage.settings && this.stage.settings.consolationFinal)
            await this.createUniqueMatchBracket('Consolation Final', stageId, 2, [semiFinalLosers]);
    }

    /**
     * Creates a double elimination stage.
     * 
     * One upper bracket (winner bracket, WB), one lower bracket (loser bracket, LB) and optionally a grand final
     * between the winner of both bracket, which can be simple or double.
     */
    private async doubleElimination() {
        if (this.stage.settings && Array.isArray(this.stage.settings.seedOrdering) &&
            this.stage.settings.seedOrdering.length < 1) throw Error('You must specify at least one seed ordering method.');

        const stageCount = await this.getStageCount();
        const stageId = await this.storage.insert<Stage>('stage', {
            tournament_id: this.tournamentId,
            name: this.stage.name,
            type: this.stage.type,
            number: stageCount + 1,
        });

        const slots = await this.getSlots();
        const { losers: losersWb, winner: winnerWb } = await this.createStandardBracket('Winner Bracket', stageId, 1, slots);
        const winnerLb = await this.createLowerBracket('Loser Bracket', stageId, 2, losersWb);

        // No Grand Final by default.
        const grandFinal = this.stage.settings && this.stage.settings.grandFinal;
        if (grandFinal === undefined) return;

        const finalDuels: Duels = [[winnerWb, winnerLb]]; // One duel by default.

        if (grandFinal === 'double') {
            // Second duel. Won't be shown if the WB winner wins the first time.
            finalDuels.push([{ id: null }, { id: null }]);
        }

        await this.createUniqueMatchBracket('Grand Final', stageId, 3, finalDuels);
    }

    /**
     * Creates a round-robin group.
     * 
     * This will make as many rounds as needed to let each participant match every other once.
     * @param name Name of the group.
     * @param stageId ID of the parent stage.
     * @param number Number in the stage.
     * @param slots A list of slots.
     */
    private async createGroup(name: string, stageId: number, number: number, slots: ParticipantSlot[]) {
        const groupId = await this.storage.insert<Group>('group', {
            stage_id: stageId,
            name,
            number,
        });

        const rounds = helpers.roundRobinMatches(slots);

        for (let i = 0; i < rounds.length; i++)
            await this.createRound(stageId, groupId, i + 1, rounds[0].length, rounds[i], this.getMatchesChildCount());
    }

    /**
     * Creates a standard bracket, which is the only one in single elimination and the upper one in double elimination.
     * 
     * This will make as many rounds as needed to end with one winner.
     * @param name Name of the bracket (group).
     * @param stageId ID of the parent stage.
     * @param number Number in the stage.
     * @param slots A list of slots.
     */
    private async createStandardBracket(name: string, stageId: number, number: number, slots: ParticipantSlot[]): Promise<{
        losers: ParticipantSlot[][],
        winner: ParticipantSlot,
    }> {
        const roundCount = Math.log2(slots.length);
        const groupId = await this.storage.insert<Group>('group', {
            stage_id: stageId,
            name,
            number,
        });

        // Inner outer by default for round 1 of standard bracket.
        const method = this.getOrdering(0, 'elimination') || 'inner_outer';
        const ordered = ordering[method](slots);

        let duels = helpers.makePairs(ordered);
        let roundNumber = 1;

        const losers: ParticipantSlot[][] = [];

        for (let i = roundCount - 1; i >= 0; i--) {
            const matchCount = Math.pow(2, i);
            duels = this.getCurrentDuels(duels, matchCount);
            losers.push(duels.map(helpers.byeLoser));
            await this.createRound(stageId, groupId, roundNumber++, matchCount, duels, this.getMatchesChildCount());
        }

        const winner = helpers.byeWinner(duels[0]);
        return { losers, winner };
    }

    /**
     * Creates a lower bracket, alternating between major and minor rounds.
     * 
     * - A major round is a regular round.
     * - A minor round matches the previous (major) round's winners against upper bracket losers of the corresponding round.
     * @param name Name of the bracket (group).
     * @param stageId ID of the parent stage.
     * @param number Number in the stage.
     * @param losers One list of losers per upper bracket round.
     */
    private async createLowerBracket(name: string, stageId: number, number: number, losers: ParticipantSlot[][]): Promise<ParticipantSlot> {
        const groupId = await this.storage.insert<Group>('group', {
            stage_id: stageId,
            name,
            number,
        });

        // The first pair of rounds (major & minor) takes the first two lists of losers.
        const roundPairCount = losers.length - 1;

        // The first list of losers contains the input for the bracket.
        const participantCount = losers[0].length * 4;

        let losersId = 0;
        let roundNumber = 1;

        const matchesChildCount = this.getMatchesChildCount();
        const method = this.getMajorOrdering(participantCount);
        const ordered = ordering[method](losers[losersId++]);

        let duels = helpers.makePairs(ordered);

        for (let i = 0; i < roundPairCount; i++) {
            const matchCount = Math.pow(2, roundPairCount - i - 1);

            // Major round.
            duels = this.getCurrentDuels(duels, matchCount, true);
            await this.createRound(stageId, groupId, roundNumber++, matchCount, duels, matchesChildCount);

            // Minor round.
            let minorOrdering = this.getMinorOrdering(participantCount, i);
            duels = this.getCurrentDuels(duels, matchCount, false, losers[losersId++], minorOrdering);
            await this.createRound(stageId, groupId, roundNumber++, matchCount, duels, matchesChildCount);
        }

        return helpers.byeWinner(duels[0]); // Winner.
    }

    /**
     * Creates a bracket with rounds that only have 1 match each. Used for finals.
     * @param name Name of the bracket (group).
     * @param stageId ID of the parent stage.
     * @param number Number in the stage.
     * @param duels A list of duels.
     */
    private async createUniqueMatchBracket(name: string, stageId: number, number: number, duels: Duels) {
        const groupId = await this.storage.insert<Group>('group', {
            stage_id: stageId,
            name,
            number,
        });

        for (let i = 0; i < duels.length; i++)
            await this.createRound(stageId, groupId, i + 1, 1, [duels[i]], this.getMatchesChildCount());
    }

    /**
     * Creates a round, which contain matches.
     * @param stageId ID of the parent stage.
     * @param groupId ID of the parent group.
     * @param roundNumber Number in the group.
     * @param matchCount Duel/match count.
     * @param duels A list of duels.
     * @param matchesChildCount Child count for each match of the round.
     */
    private async createRound(stageId: number, groupId: number, roundNumber: number, matchCount: number, duels: Duels, matchesChildCount: number) {
        const roundId = await this.storage.insert<Round>('round', {
            number: roundNumber,
            stage_id: stageId,
            group_id: groupId,
        });

        for (let i = 0; i < matchCount; i++)
            await this.createMatch(stageId, groupId, roundId, i + 1, duels[i], matchesChildCount);
    }

    /**
     * Creates a match, possibly with match games.
     * 
     * - If `childCount` is 0, then there is no children. The score of the match is directly its intrinsic score.
     * - If `childCount` is greater than 0, then the score of the match will automatically be calculated based on its child games.
     * @param stageId ID of the parent stage.
     * @param groupId ID of the parent group.
     * @param roundId ID of the parent round.
     * @param matchNumber Number in the round.
     * @param opponents The two opponents matching against each other.
     * @param childCount Child count for this match (number of games).
     */
    private async createMatch(stageId: number, groupId: number, roundId: number, matchNumber: number, opponents: Duel, childCount: number) {
        const parentId = await this.storage.insert<Match>('match', {
            number: matchNumber,
            stage_id: stageId,
            group_id: groupId,
            round_id: roundId,
            child_count: childCount,
            status: 'pending',
            locked: false, // TODO: update that.
            scheduled_datetime: null,
            start_datetime: null,
            end_datetime: null,
            opponent1: helpers.toResult(opponents[0]),
            opponent2: helpers.toResult(opponents[1]),
        });

        for (let i = 0; i < childCount; i++) {
            await this.storage.insert<MatchGame>('match_game', {
                number: i + 1,
                parent_id: parentId,
                status: 'pending',
                scheduled_datetime: null,
                start_datetime: null,
                end_datetime: null,
                opponent1: helpers.toResult(opponents[0]),
                opponent2: helpers.toResult(opponents[1]),
            });
        }
    }

    /**
     * Gets the duels for the current round based on the previous one. No ordering is done, it must be done beforehand for the first round.
     * @param previousDuels Duels of the previous round.
     * @param currentDuelCount Count of duels (matches) in the current round.
     */
    private getCurrentDuels(previousDuels: Duels, currentDuelCount: number): Duels;

    /**
     * Gets the duels for a major round in the LB. No ordering is done, it must be done beforehand for the first round.
     * @param previousDuels Duels of the previous round.
     * @param currentDuelCount Count of duels (matches) in the current round.
     * @param major Indicates that the round is a major round in the LB.
     */
    private getCurrentDuels(previousDuels: Duels, currentDuelCount: number, major: true): Duels;

    /**
     * Gets the duels for a minor round in the LB. Ordering is done.
     * @param previousDuels Duels of the previous round.
     * @param currentDuelCount Count of duels (matches) in the current round.
     * @param major Indicates that the round is a minor round in the LB.
     * @param losers The losers going from the WB.
     * @param method The ordering method to apply to the losers.
     */
    private getCurrentDuels(previousDuels: Duels, currentDuelCount: number, major: false, losers: ParticipantSlot[], method: SeedOrdering): Duels;

    private getCurrentDuels(previousDuels: Duels, currentDuelCount: number, major?: boolean, losers?: ParticipantSlot[], method?: SeedOrdering): Duels {
        if ((major === undefined || major === true) && previousDuels.length === currentDuelCount) {
            return previousDuels; // First round.
        }

        const currentDuels: Duels = [];

        if (major === undefined || major === true) { // From major to major (WB) or minor to major (LB).
            for (let duelId = 0; duelId < currentDuelCount; duelId++) {
                const prevDuelId = duelId * 2;
                currentDuels.push([
                    helpers.byeWinner(previousDuels[prevDuelId + 0]), // opponent1.
                    helpers.byeWinner(previousDuels[prevDuelId + 1]), // opponent2.
                ]);
            }
        } else { // From major to minor (LB).
            losers = ordering[method!](losers!);

            for (let duelId = 0; duelId < currentDuelCount; duelId++) {
                const prevDuelId = duelId;
                currentDuels.push([
                    losers![prevDuelId], // opponent1.
                    helpers.byeWinner(previousDuels[prevDuelId]), // opponent2.
                ]);
            }
        }

        return currentDuels;
    }

    /**
     * Returns a list of slots.
     * - If `participants` were given, inserts them in the storage.
     * - If `size` was given, only returns a list of empty slots.
     */
    private async getSlots(): Promise<ParticipantSlot[]> {
        if (this.stage.size && this.stage.participants) throw Error('Cannot set size and participants at the same time.');

        if (this.stage.size)
            return Array.from(Array(this.stage.size), (_: ParticipantSlot, i) => ({ id: null, position: i + 1 }));

        if (!this.stage.participants) throw Error('Either size or participants must be given.');

        const withoutByes: string[] = this.stage.participants.filter(name => name !== null) as any;

        const participants = withoutByes.map<Omit<Participant, 'id'>>(name => ({
            tournament_id: this.tournamentId,
            name,
        }));

        if (!await this.storage.insert<Participant>('participant', participants)) {
            throw Error('Error registering the participants.');
        }

        const added = await this.storage.select<Participant>('participant', { tournament_id: this.tournamentId });
        if (!added) throw Error('Error getting registered participant.');

        const slots = this.stage.participants.map<ParticipantSlot>((name, i) => {
            if (name === null) return null; // BYE.

            const found = added.find(participant => participant.name === name);
            if (!found) throw Error('Participant name not found in database.');

            return { id: found.id, position: i + 1 };
        });

        return slots;
    }

    private async getStageCount(): Promise<number> {
        const stages = await this.storage.select<Stage>('stage', { tournament_id: this.tournamentId });
        const stageCount = stages ? stages.length : 0;
        return stageCount;
    }

    /**
     * Safely gets `matchesChildCount` in the stage input settings.
     */
    private getMatchesChildCount(): number {
        if (this.stage.settings === undefined || this.stage.settings.matchesChildCount === undefined) return 0;
        return this.stage.settings.matchesChildCount;
    }

    /**
     * Safely gets an ordering by its index in the stage input settings.
     * @param index Index of the ordering.
     * @param stageType A value indicating if the method should be a group method or not.
     */
    private getOrdering(index: number, stageType: 'elimination' | 'groups'): SeedOrdering | null {
        if (this.stage.settings === undefined || this.stage.settings.seedOrdering === undefined) return null;

        const method = this.stage.settings.seedOrdering[index];
        if (!method) return null;

        if (stageType === 'elimination' && method.match(/^groups\./))
            throw Error('You must specify a seed ordering method without a \'groups\' prefix');

        if (stageType === 'groups' && !method.match(/^groups\./))
            throw Error('You must specify a seed ordering method with a \'groups\' prefix');

        return method;
    }

    /**
     * Safely gets the only major ordering for the lower bracket.
     * @param participantCount Number of participants in the stage.
     */
    private getMajorOrdering(participantCount: number): SeedOrdering {
        const ordering = this.getOrdering(1, 'elimination');
        return ordering || defaultMinorOrdering[participantCount][0];
    }

    /**
     * Safely gets a minor ordering for the lower bracket by its index.
     * @param participantCount Number of participants in the stage.
     * @param index Index of the minor round.
     */
    private getMinorOrdering(participantCount: number, index: number): SeedOrdering {
        const ordering = this.getOrdering(2 + index, 'elimination');
        return ordering || defaultMinorOrdering[participantCount][1 + index];
    }
}