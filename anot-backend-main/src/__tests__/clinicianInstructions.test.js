const pool = require('../config/db')
const { getClinicianAiInstructions } = require('../utils/clinicianInstructions')

jest.mock('../config/db', () => ({
    query: jest.fn(),
}))

describe('getClinicianAiInstructions', () => {
    afterEach(() => {
        jest.clearAllMocks()
    })

    test('returns null when clinicianId is falsy or invalid', async () => {
        expect(await getClinicianAiInstructions(null)).toBeNull()
        expect(await getClinicianAiInstructions('')).toBeNull()
        expect(await getClinicianAiInstructions('invalid-id')).toBeNull()
        expect(pool.query).not.toHaveBeenCalled()
    })

    test('returns trimmed instructions when doctor has custom directives', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ ai_note_instructions: '  Always write Assessment & Plan with numbered problems.  ' }],
        })

        const result = await getClinicianAiInstructions(42)
        expect(pool.query).toHaveBeenCalledWith(
            'SELECT ai_note_instructions FROM users WHERE id = $1',
            [42]
        )
        expect(result).toBe('Always write Assessment & Plan with numbered problems.')
    })

    test('returns null when doctor has empty or null instructions', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ ai_note_instructions: null }],
        })
        expect(await getClinicianAiInstructions(42)).toBeNull()

        pool.query.mockResolvedValueOnce({
            rows: [{ ai_note_instructions: '   ' }],
        })
        expect(await getClinicianAiInstructions(42)).toBeNull()
    })

    test('returns null on database error without throwing', async () => {
        pool.query.mockRejectedValueOnce(new Error('DB connection failed'))
        const result = await getClinicianAiInstructions(42)
        expect(result).toBeNull()
    })
})
