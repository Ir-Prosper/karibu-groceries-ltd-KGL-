/*
 * In-memory branch store:
 * - Provides fallback branch data helpers.
 * - Used as lightweight local state utility.
 */

let branches = [
  {
    _id: '1',
    name: 'Maganjo',
    location: 'Kampala, Uganda',
    contact: '0771234567',
    email: 'maganjo@karibugroceries.com',
    manager: 'Prosper IRAKOZE',
    status: 'active',
    createdAt: new Date('2024-01-01')
  },
  {
    _id: '2',
    name: 'Matugga',
    location: 'Wakiso District, Uganda',
    contact: '0772345678',
    email: 'matugga@karibugroceries.com',
    manager: 'Chris NKURUNZIZA',
    status: 'active',
    createdAt: new Date('2024-01-01')
  }
];

function getBranches() {
  return branches;
}

function setBranches(nextBranches) {
  branches = nextBranches;
}

function findBranchById(id) {
  return branches.find((b) => b._id === id);
}

function findBranchByName(name) {
  return branches.find((b) => b.name === name);
}

module.exports = {
  getBranches,
  setBranches,
  findBranchById,
  findBranchByName
};
